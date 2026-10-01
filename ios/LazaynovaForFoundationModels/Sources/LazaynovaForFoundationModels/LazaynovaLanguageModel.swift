import Foundation
import FoundationModels

/// A Foundation Models bridge for Lazaynova's authenticated Chat route.
/// The host app must obtain the bearer session from its login flow and keep it in Keychain.
public struct LazaynovaLanguageModel: LanguageModel {
    public typealias Executor = LazaynovaLanguageModelExecutor

    public let capabilities = LanguageModelCapabilities([])
    public let executorConfiguration: LazaynovaLanguageModelExecutor.Configuration

    public init(baseURL: URL, bearerSessionToken: String) throws {
        guard let components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              bearerSessionToken.range(of: #"^[A-Za-z0-9_-]{30,512}$"#, options: .regularExpression) != nil,
              var endpoint = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw LazaynovaLanguageModelError.invalidConfiguration
        }

        endpoint.path = "/v1/lazaynova/chat/stream"
        guard let endpointURL = endpoint.url else {
            throw LazaynovaLanguageModelError.invalidConfiguration
        }

        executorConfiguration = .init(endpoint: endpointURL, bearerSessionToken: bearerSessionToken)
    }
}

public struct LazaynovaLanguageModelExecutor: LanguageModelExecutor {
    public typealias Model = LazaynovaLanguageModel

    public struct Configuration: Hashable, Sendable {
        fileprivate let endpoint: URL
        fileprivate let bearerSessionToken: String
    }

    private let configuration: Configuration

    public init(configuration: Configuration) throws {
        self.configuration = configuration
    }

    nonisolated(nonsending)
    public func respond(
        to request: LanguageModelExecutorGenerationRequest,
        model: LazaynovaLanguageModel,
        streamingInto channel: LanguageModelExecutorGenerationChannel
    ) async throws {
        guard request.schema == nil else {
            throw LazaynovaLanguageModelError.unsupportedFeature
        }
        guard request.enabledToolDefinitions.isEmpty else {
            throw LazaynovaLanguageModelError.unsupportedFeature
        }

        let messages = try Self.messages(from: request.transcript)
        let body = ChatRequest(messages: messages)
        var urlRequest = URLRequest(url: configuration.endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 120
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        urlRequest.setValue("Bearer \(configuration.bearerSessionToken)", forHTTPHeaderField: "Authorization")
        urlRequest.httpBody = try JSONEncoder().encode(body)

        let (bytes, response) = try await URLSession.shared.bytes(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw LazaynovaLanguageModelError.httpStatus(statusCode)
        }

        let entryID = request.id.uuidString
        let result = try await Self.readResult(from: bytes, entryID: entryID, channel: channel)
        await channel.send(.response(entryID: entryID, action: .updateMetadata([
            "provider": result.provenance?.provider ?? "Lazaynova",
            "modelID": result.provenance?.model ?? "server-routed",
            "requestID": result.provenance?.requestId ?? request.id.uuidString,
        ])))
        if let usage = result.provenance?.usage {
            await channel.send(.response(
                entryID: entryID,
                action: .updateUsage(
                    input: .init(totalTokenCount: usage.inputTokens, cachedTokenCount: 0),
                    output: .init(totalTokenCount: usage.outputTokens, reasoningTokenCount: 0),
                    metadata: [:]
                )
            ))
        }
    }

    private static func messages(from transcript: Transcript) throws -> [ChatMessage] {
        var messages: [ChatMessage] = []
        for entry in transcript.history {
            switch entry {
            case .prompt(let prompt):
                messages.append(ChatMessage(role: "user", content: try text(from: prompt.segments)))
            case .response(let response):
                messages.append(ChatMessage(role: "assistant", content: try text(from: response.segments)))
            case .instructions, .reasoning:
                // Server-side system instructions remain authoritative; internal reasoning is not forwarded.
                continue
            case .toolCalls, .toolOutput:
                throw LazaynovaLanguageModelError.unsupportedFeature
            @unknown default:
                throw LazaynovaLanguageModelError.unsupportedTranscript
            }
        }

        guard !messages.isEmpty,
              messages.count <= 40,
              messages[0].role == "user",
              messages[messages.count - 1].role == "user",
              messages.enumerated().allSatisfy({ index, message in
                  index == 0 || message.role != messages[index - 1].role
              }),
              messages.reduce(0, { $0 + $1.content.count }) <= 40_000 else {
            throw LazaynovaLanguageModelError.unsupportedTranscript
        }
        return messages
    }

    private static func text(from segments: [Transcript.Segment]) throws -> String {
        var content = ""
        for segment in segments {
            switch segment {
            case .text(let textSegment):
                content.append(textSegment.content)
            case .attachment, .structure:
                throw LazaynovaLanguageModelError.unsupportedFeature
            @unknown default:
                throw LazaynovaLanguageModelError.unsupportedTranscript
            }
        }
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LazaynovaLanguageModelError.unsupportedTranscript
        }
        return content
    }

    private static func readResult(
        from bytes: URLSession.AsyncBytes,
        entryID: String,
        channel: LanguageModelExecutorGenerationChannel
    ) async throws -> ChatResult {
        var currentEvent: String?
        var result: ChatResult?
        var outputBytes = 0
        var segmentID: String?

        for try await line in bytes.lines {
            if line.isEmpty {
                currentEvent = nil
                continue
            }
            if line.hasPrefix("event: ") {
                currentEvent = String(line.dropFirst("event: ".count))
                continue
            }
            guard line.hasPrefix("data: "), let event = currentEvent else { continue }
            let payload = String(line.dropFirst("data: ".count))

            switch event {
            case "delta":
                let delta = try JSONDecoder().decode(ChatDelta.self, from: Data(payload.utf8))
                outputBytes += delta.content.utf8.count
                guard outputBytes <= 1_000_000 else { throw LazaynovaLanguageModelError.responseTooLarge }
                if segmentID == nil { segmentID = UUID().uuidString }
                await channel.send(.response(
                    entryID: entryID,
                    action: .appendText(delta.content, segmentID: segmentID, tokenCount: 0)
                ))
            case "result":
                guard payload.utf8.count <= 64_000 else { throw LazaynovaLanguageModelError.responseTooLarge }
                result = try JSONDecoder().decode(ChatResult.self, from: Data(payload.utf8))
            case "error":
                let serverError = try? JSONDecoder().decode(ChatStreamError.self, from: Data(payload.utf8))
                throw LazaynovaLanguageModelError.server(
                    code: serverError?.code ?? "CHAT_REQUEST_FAILED",
                    message: serverError?.message ?? "The chat request failed."
                )
            case "done":
                guard payload == "[DONE]", let result, outputBytes > 0 else {
                    throw LazaynovaLanguageModelError.missingResult
                }
                return result
            default:
                continue
            }
        }

        throw LazaynovaLanguageModelError.missingResult
    }
}

private struct ChatRequest: Encodable {
    let messages: [ChatMessage]
}

private struct ChatMessage: Codable, Sendable {
    let role: String
    let content: String
}

private struct ChatDelta: Decodable {
    let content: String
}

private struct ChatResult: Decodable {
    let provenance: Provenance?

    struct Provenance: Decodable {
        let provider: String?
        let model: String?
        let requestId: String?
        let usage: Usage?
    }

    struct Usage: Decodable {
        let inputTokens: Int
        let outputTokens: Int
    }
}

private struct ChatStreamError: Decodable {
    let code: String
    let message: String
}

public enum LazaynovaLanguageModelError: Error, LocalizedError, Sendable {
    case invalidConfiguration
    case unsupportedFeature
    case unsupportedTranscript
    case httpStatus(Int)
    case server(code: String, message: String)
    case responseTooLarge
    case missingResult

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration:
            return "Use an HTTPS Lazaynova API base URL and a valid bearer session token."
        case .unsupportedFeature:
            return "This Lazaynova adapter supports text chat only; tools, attachments, and guided output are unavailable."
        case .unsupportedTranscript:
            return "The Foundation Models transcript could not be represented as a supported Lazaynova chat conversation."
        case .httpStatus(let status):
            return status == 401 ? "The Lazaynova session is invalid or expired." : "The Lazaynova chat request was rejected (HTTP \(status))."
        case .server(_, let message):
            return message
        case .responseTooLarge:
            return "The Lazaynova chat response exceeded the client limit."
        case .missingResult:
            return "The Lazaynova stream ended without a complete response."
        }
    }
}
