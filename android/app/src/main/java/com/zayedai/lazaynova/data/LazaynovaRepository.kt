package com.zayedai.lazaynova.data

import java.time.Instant
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow

/** App data boundary. The mock implementation never delegates to the HTTP API. */
interface LazaynovaRepository {
    suspend fun createSession(baseUrl: String, email: String, password: String): LazaynovaApi.Session
    suspend fun getUsage(session: LazaynovaApi.Session): LazaynovaApi.UsageSummary
    suspend fun getCapabilities(session: LazaynovaApi.Session): CapabilitySnapshot
    fun streamChat(session: LazaynovaApi.Session, messages: List<LazaynovaApi.ChatMessage>): Flow<LazaynovaApi.ChatStreamEvent>
}

class ApiLazaynovaRepository(private val api: LazaynovaApi = LazaynovaApi()) : LazaynovaRepository {
    override suspend fun createSession(baseUrl: String, email: String, password: String) = api.createSession(baseUrl, email, password)
    override suspend fun getUsage(session: LazaynovaApi.Session) = api.getUsage(session)
    override suspend fun getCapabilities(session: LazaynovaApi.Session) = api.getCapabilities(session)
    override fun streamChat(session: LazaynovaApi.Session, messages: List<LazaynovaApi.ChatMessage>) = api.streamChat(session, messages)
}

/** Local-only fixtures for previews/manual UI checks. Never sends login data, prompts, or tokens. */
class MockLazaynovaRepository(
    private val now: () -> Instant = Instant::now,
    private val tokenDelayMillis: Long = 35,
    private val previewStepDelayMillis: Long = 350,
) : LazaynovaRepository,
    MockPreviewRepository {
    override suspend fun createSession(baseUrl: String, email: String, password: String): LazaynovaApi.Session {
        require(email.isNotBlank()) { "أدخل بريدًا تجريبيًا." }
        return LazaynovaApi.Session("https://mock.lazaynova.invalid", "mock-session-not-a-credential", email.trim())
    }

    override suspend fun getUsage(session: LazaynovaApi.Session) = LazaynovaApi.UsageSummary(
        currency = "USD",
        requestCount = "12",
        reportedUsageCount = "12",
        unreportedUsageCount = "0",
        nonTokenRequestCount = "0",
        pricedRequestCount = "12",
        unpricedRequestCount = "0",
        inputTokens = "8420",
        outputTokens = "3175",
        costMicrousd = "186400",
    )

    override suspend fun getCapabilities(session: LazaynovaApi.Session): CapabilitySnapshot {
        val serverTime = now()
        val minuteReset = serverTime.truncatedTo(ChronoUnit.MINUTES).plus(1, ChronoUnit.MINUTES)
        val utcDayReset = serverTime.atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
        fun quota(limitMinute: Int, usedMinute: Int, limitDay: Int, usedDay: Int) = ToolUsageSnapshot(
            callsPerMinute = limitMinute,
            usedThisMinute = usedMinute,
            minuteResetAt = minuteReset,
            callsPerDay = limitDay,
            usedToday = usedDay,
            utcDayResetAt = utcDayReset,
            serverTime = serverTime,
            receivedAt = serverTime,
        )
        return CapabilitySnapshot(
            capabilities = listOf(
                CapabilityGrantSnapshot("CHAT", granted = true, ready = true, toolGrants = emptyList()),
                CapabilityGrantSnapshot("WRITING", granted = true, ready = true, toolGrants = emptyList()),
                CapabilityGrantSnapshot(
                    "WEB_RESEARCH",
                    granted = true,
                    ready = true,
                    toolGrants = listOf(ToolGrantSnapshot("web.search", granted = true, usage = quota(20, 4, 200, 200))),
                ),
                CapabilityGrantSnapshot(
                    "FILE_ANALYSIS",
                    granted = false,
                    ready = true,
                    toolGrants = listOf(ToolGrantSnapshot("file.read_text", granted = false, usage = quota(30, 2, 500, 86))),
                ),
                CapabilityGrantSnapshot("CODING", granted = false, ready = false, toolGrants = emptyList()),
                CapabilityGrantSnapshot("PROJECT", granted = false, ready = false, toolGrants = emptyList()),
                CapabilityGrantSnapshot("MODEL_ANALYSIS", granted = true, ready = false, toolGrants = emptyList()),
            ),
        )
    }

    /** Emits whitespace-preserving text chunks to exercise the same incremental Compose path as SSE. */
    fun streamText(messages: List<LazaynovaApi.ChatMessage>): Flow<String> = flow {
        require(messages.isNotEmpty())
        val response = "[محاكاة محلية] هذه إجابة تجريبية متدفقة قطرة بقطرة؛ لم يُرسل نصك إلى أي خادم."
        val chunks = Regex("\\S+\\s*").findAll(response).map { it.value }.toList()
        chunks.forEachIndexed { index, chunk ->
            emit(chunk)
            if (index < chunks.lastIndex && tokenDelayMillis > 0) delay(tokenDelayMillis)
        }
    }

    override fun streamChat(
        session: LazaynovaApi.Session,
        messages: List<LazaynovaApi.ChatMessage>,
    ) = flow {
        streamText(messages).collect { chunk ->
            emit(LazaynovaApi.ChatStreamEvent.TextDelta(chunk))
        }
        emit(
            LazaynovaApi.ChatStreamEvent.Completed(
                LazaynovaApi.ChatProvenance("mock", "local-preview", "mock-request", null, null),
            ),
        )
    }

    override fun streamDagPreview(): Flow<MockDagSnapshot> = flow {
        emit(dagSnapshot(MockDagRunStatus.QUEUED, 0f, MockDagNodeStatus.PENDING, MockDagNodeStatus.PENDING))
        delay(previewStepDelayMillis.coerceAtLeast(0))
        emit(dagSnapshot(MockDagRunStatus.RUNNING, 0.28f, MockDagNodeStatus.RUNNING, MockDagNodeStatus.PENDING))
        delay(previewStepDelayMillis.coerceAtLeast(0))
        emit(dagSnapshot(MockDagRunStatus.WAITING_APPROVAL, 0.55f, MockDagNodeStatus.COMPLETED, MockDagNodeStatus.WAITING_APPROVAL))
    }

    override fun approveDagPreview(runId: String): Flow<MockDagSnapshot> {
        if (runId != MOCK_DAG_RUN_ID) return emptyFlow()
        return flow {
            delay(previewStepDelayMillis.coerceAtLeast(0))
            emit(dagSnapshot(MockDagRunStatus.RUNNING, 0.78f, MockDagNodeStatus.COMPLETED, MockDagNodeStatus.RUNNING, approvalIsSimulated = true))
            delay(previewStepDelayMillis.coerceAtLeast(0))
            emit(dagSnapshot(MockDagRunStatus.COMPLETED, 1f, MockDagNodeStatus.COMPLETED, MockDagNodeStatus.COMPLETED, approvalIsSimulated = true))
        }
    }

    private fun dagSnapshot(
        status: MockDagRunStatus,
        progress: Float,
        planningStatus: MockDagNodeStatus,
        researchStatus: MockDagNodeStatus,
        approvalIsSimulated: Boolean = false,
    ) = MockDagSnapshot(
        runId = MOCK_DAG_RUN_ID,
        status = status,
        progress = progress,
        nodes = listOf(
            MockDagNodeSnapshot("plan", "التخطيط", planningStatus, FeatureAvailability.AVAILABLE),
            MockDagNodeSnapshot("research", "البحث · موافقة تجريبية", researchStatus, FeatureAvailability.AVAILABLE),
            MockDagNodeSnapshot("file", "تحليل ملف", MockDagNodeStatus.BLOCKED, FeatureAvailability.UNSUPPORTED_CLIENT),
            MockDagNodeSnapshot("model", "تحليل نموذج", MockDagNodeStatus.BLOCKED, FeatureAvailability.BACKEND_UNAVAILABLE),
        ),
        approvalIsSimulated = approvalIsSimulated,
    )

    private companion object {
        const val MOCK_DAG_RUN_ID = "mock-run-preview"
    }
}
