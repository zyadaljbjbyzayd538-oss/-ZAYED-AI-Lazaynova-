package com.zayedai.lazaynova.data

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Authenticated HTTP boundary; the app never chooses provider or model IDs. */
class LazaynovaApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(150, TimeUnit.SECONDS)
        .build()

    suspend fun createSession(baseUrl: String, email: String, password: String): Session {
        val origin = validatedOrigin(baseUrl)
        val body = JSONObject().put("email", email.trim()).put("password", password).toString()
            .toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url(endpoint(origin, "v1/auth/sessions"))
            .header("Accept", "application/json")
            .post(body)
            .build()

        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            client.newCall(request).execute().use { response ->
                if (response.code != 201) throw ApiException("تعذّر تسجيل الدخول (HTTP ${response.code}).")
                val payload = response.body?.byteStream()?.let { readBounded(it, MAX_JSON_BYTES) }
                    ?: throw ApiException("استجابة تسجيل الدخول غير صالحة.")
                val json = JSONObject(decodeUtf8(payload))
                val token = json.getString("token")
                val expiresAt = json.getString("expiresAt")
                if (!TOKEN_PATTERN.matches(token) || expiresAt.isBlank()) {
                    throw ApiException("استجابة تسجيل الدخول غير صالحة.")
                }
                val account = json.getJSONObject("user")
                Session(origin.toString().removeSuffix("/"), token, account.optString("email"))
            }
        }
    }

    suspend fun getUsage(session: Session): UsageSummary = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val request = Request.Builder()
            .url(endpoint(validatedOrigin(session.baseUrl), "v1/usage"))
            .header("Accept", "application/json")
            .header("Authorization", "Bearer ${session.bearerToken}")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            if (response.code != 200) throw ApiException("ملخص الاستخدام غير متاح حاليًا (HTTP ${response.code}).")
            val payload = response.body?.byteStream()?.let { readBounded(it, MAX_JSON_BYTES) }
                ?: throw ApiException("ملخص الاستخدام فارغ.")
            val json = JSONObject(decodeUtf8(payload))
            fun count(name: String): String {
                val value = json.optString(name)
                if (!COUNT_PATTERN.matches(value)) throw ApiException("ملخص الاستخدام من الخادم غير صالح.")
                return value
            }
            UsageSummary(
                currency = json.optString("currency").takeIf { it == "USD" }
                    ?: throw ApiException("عملة ملخص الاستخدام غير مدعومة."),
                requestCount = count("requestCount"),
                reportedUsageCount = count("reportedUsageCount"),
                unreportedUsageCount = count("unreportedUsageCount"),
                nonTokenRequestCount = count("nonTokenRequestCount"),
                pricedRequestCount = count("pricedRequestCount"),
                unpricedRequestCount = count("unpricedRequestCount"),
                inputTokens = count("inputTokens"),
                outputTokens = count("outputTokens"),
                costMicrousd = count("costMicrousd"),
            )
        }
    }

    suspend fun getCapabilities(session: Session): CapabilitySnapshot = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val request = Request.Builder()
            .url(endpoint(validatedOrigin(session.baseUrl), "v1/agent/capabilities"))
            .header("Accept", "application/json")
            .header("Authorization", "Bearer ${session.bearerToken}")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            if (response.code != 200) throw ApiException("حالة الصلاحيات والحصص غير متاحة حاليًا (HTTP ${response.code}).")
            val payload = response.body?.byteStream()?.let { readBounded(it, MAX_JSON_BYTES) }
                ?: throw ApiException("استجابة الصلاحيات فارغة.")
            try {
                val rows = JSONObject(decodeUtf8(payload)).getJSONArray("capabilities")
                val receivedAt = Instant.now()
                val capabilities = (0 until rows.length()).map { index ->
                    val row = rows.getJSONObject(index)
                    val grants = row.optJSONArray("toolGrants") ?: JSONArray()
                    val toolGrants = (0 until grants.length()).map { grantIndex ->
                        val grant = grants.getJSONObject(grantIndex)
                        val usage = grant.optJSONObject("usage")?.let { usageJson ->
                            fun count(name: String): Int {
                                val raw = try {
                                    usageJson.get(name)
                                } catch (_: Exception) {
                                    throw ApiException("عداد حصة الأداة غير صالح.")
                                }
                                val number = raw as? Number ?: throw ApiException("عداد حصة الأداة غير صالح.")
                                val longValue = number.toLong()
                                if (number.toDouble() != longValue.toDouble() || longValue !in 0..Int.MAX_VALUE.toLong()) {
                                    throw ApiException("عداد حصة الأداة غير صالح.")
                                }
                                return longValue.toInt()
                            }
                            fun timestamp(name: String): Instant = try {
                                Instant.parse(usageJson.getString(name))
                            } catch (_: Exception) {
                                throw ApiException("موعد إعادة ضبط الحصة غير صالح.")
                            }
                            val snapshot = ToolUsageSnapshot(
                                callsPerMinute = count("callsPerMinute"),
                                usedThisMinute = count("usedThisMinute"),
                                minuteResetAt = timestamp("minuteResetAt"),
                                callsPerDay = count("callsPerDay"),
                                usedToday = count("usedToday"),
                                utcDayResetAt = timestamp("utcDayResetAt"),
                                serverTime = timestamp("serverTime"),
                                receivedAt = receivedAt,
                            )
                            val expectedMinuteReset = snapshot.serverTime.truncatedTo(ChronoUnit.MINUTES).plus(1, ChronoUnit.MINUTES)
                            val expectedUtcDayReset = snapshot.serverTime.atZone(ZoneOffset.UTC)
                                .toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
                            if (snapshot.callsPerMinute <= 0 ||
                                snapshot.callsPerDay <= 0 ||
                                snapshot.minuteResetAt != expectedMinuteReset ||
                                snapshot.utcDayResetAt != expectedUtcDayReset
                            ) {
                                throw ApiException("حدود حصة الأداة غير متسقة.")
                            }
                            snapshot
                        }
                        ToolGrantSnapshot(
                            name = grant.getString("name"),
                            granted = grant.getBoolean("granted"),
                            usage = usage,
                        )
                    }
                    CapabilityGrantSnapshot(
                        capability = row.getString("capability"),
                        granted = row.getBoolean("granted"),
                        ready = row.getBoolean("ready"),
                        toolGrants = toolGrants,
                    )
                }
                CapabilitySnapshot(capabilities)
            } catch (error: ApiException) {
                throw error
            } catch (_: Exception) {
                throw ApiException("استجابة الصلاحيات والحصص من الخادم غير صالحة.")
            }
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    fun streamChat(session: Session, messages: List<ChatMessage>): Flow<ChatStreamEvent> = callbackFlow {
        require(messages.isNotEmpty() && messages.size <= MAX_MESSAGES)
        require(messages.all { it.role == "user" || it.role == "assistant" })
        require(messages.first().role == "user" && messages.last().role == "user")
        require(messages.zipWithNext().all { (left, right) -> left.role != right.role })
        require(messages.sumOf { it.content.length } <= MAX_CONVERSATION_CHARS)

        val jsonMessages = JSONArray().apply {
            messages.forEach { message ->
                put(JSONObject().put("role", message.role).put("content", message.content))
            }
        }
        val requestBody = JSONObject().put("messages", jsonMessages).toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url(endpoint(validatedOrigin(session.baseUrl), "v1/lazaynova/chat/stream"))
            .header("Accept", "text/event-stream")
            .header("Authorization", "Bearer ${session.bearerToken}")
            .post(requestBody)
            .build()
        val call = client.newCall(request)
        val producer = this
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, error: IOException) {
                producer.close(ApiException("تعذّر الاتصال بخادم Lazaynova."))
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use { safeResponse ->
                    try {
                        if (!safeResponse.isSuccessful) {
                            throw ApiException("تعذّر إكمال المحادثة (HTTP ${safeResponse.code}).")
                        }
                        if (!safeResponse.header("Content-Type").orEmpty().lowercase().startsWith("text/event-stream")) {
                            throw ApiException("استجابة المحادثة ليست تدفق SSE صالحًا.")
                        }
                        val input = safeResponse.body?.byteStream()
                            ?: throw ApiException("انتهى تدفق المحادثة دون محتوى.")
                        SseChatReader.read(input) { event ->
                            if (producer.trySendBlocking(event).isFailure) throw IOException("Chat consumer closed.")
                        }
                        producer.close()
                    } catch (error: Exception) {
                        producer.close(if (error is ApiException) error else ApiException("انتهى تدفق المحادثة قبل اكتماله."))
                    }
                }
            }
        })

        awaitClose { call.cancel() }
    }

    private fun endpoint(origin: HttpUrl, path: String): HttpUrl = origin.newBuilder().addPathSegments(path).build()

    private fun validatedOrigin(value: String): HttpUrl {
        val url = value.trim().toHttpUrlOrNull() ?: throw ApiException("أدخل عنوان خادم صالحًا.")
        if (!url.isHttps ||
            url.encodedPath != "/" ||
            url.encodedQuery != null ||
            url.encodedFragment != null ||
            url.username.isNotEmpty() ||
            url.password.isNotEmpty()
        ) {
            throw ApiException("يجب أن يكون عنوان الخادم HTTPS فقط، دون مسار أو بيانات اعتماد.")
        }
        return url
    }

    private fun readBounded(input: InputStream, limit: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4_096)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size() + count > limit) throw ApiException("استجابة الخادم تجاوزت الحد المسموح.")
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun decodeUtf8(bytes: ByteArray): String = try {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: Exception) {
        throw ApiException("استجابة الخادم ليست UTF-8 صالحًا.")
    }

    data class Session(val baseUrl: String, val bearerToken: String, val email: String)
    data class UsageSummary(
        val currency: String,
        val requestCount: String,
        val reportedUsageCount: String,
        val unreportedUsageCount: String,
        val nonTokenRequestCount: String,
        val pricedRequestCount: String,
        val unpricedRequestCount: String,
        val inputTokens: String,
        val outputTokens: String,
        val costMicrousd: String,
    )
    data class ChatMessage(val role: String, val content: String)

    sealed interface ChatStreamEvent {
        data class TextDelta(val content: String) : ChatStreamEvent
        data class Completed(val provenance: ChatProvenance) : ChatStreamEvent
    }

    data class ChatProvenance(
        val provider: String,
        val model: String,
        val requestId: String,
        val inputTokens: Int?,
        val outputTokens: Int?,
    )

    class ApiException(message: String) : IOException(message)

    private class SseChatReader {
        companion object {
            fun read(input: InputStream, emit: (ChatStreamEvent) -> Unit) {
                var eventName = "message"
                val dataLines = mutableListOf<String>()
                var totalBytes = 0
                var outputBytes = 0
                var sawResult = false
                var sawText = false
                var sawDone = false
                var provenance: ChatProvenance? = null

                fun dispatch() {
                    if (dataLines.isEmpty()) {
                        eventName = "message"
                        return
                    }
                    val payload = dataLines.joinToString("\n")
                    dataLines.clear()
                    when (eventName) {
                        "delta" -> {
                            if (sawResult) throw ApiException("وصل نص بعد حدث الإكمال.")
                            val content = JSONObject(payload).getString("content")
                            if (content.isEmpty()) throw ApiException("وصلت دلتا نص فارغة.")
                            outputBytes += content.toByteArray(StandardCharsets.UTF_8).size
                            if (outputBytes > MAX_OUTPUT_BYTES) throw ApiException("الإجابة تجاوزت الحد المسموح.")
                            sawText = true
                            emit(ChatStreamEvent.TextDelta(content))
                        }
                        "result" -> {
                            if (sawResult) throw ApiException("تكرر حدث نتيجة المحادثة.")
                            if (payload.toByteArray(StandardCharsets.UTF_8).size > MAX_RESULT_BYTES) {
                                throw ApiException("بيانات نتيجة المحادثة كبيرة جدًا.")
                            }
                            val root = JSONObject(payload).getJSONObject("provenance")
                            val provider = root.optString("provider")
                            val model = root.optString("model")
                            val requestId = root.optString("requestId")
                            if (provider.isBlank() || model.isBlank() || requestId.isBlank()) {
                                throw ApiException("بيانات مصدر النموذج غير مكتملة.")
                            }
                            val usage = root.optJSONObject("usage")
                            provenance = ChatProvenance(
                                provider = provider,
                                model = model,
                                requestId = requestId,
                                inputTokens = usage?.optInt("inputTokens")?.takeIf { it >= 0 },
                                outputTokens = usage?.optInt("outputTokens")?.takeIf { it >= 0 },
                            )
                            sawResult = true
                        }
                        "error" -> {
                            val code = JSONObject(payload).optString("code").takeIf { SAFE_CODE.matches(it) } ?: "CHAT_REQUEST_FAILED"
                            throw ApiException("تعذّر إكمال الطلب ($code).")
                        }
                        "done" -> {
                            if (payload != "[DONE]" || !sawResult || !sawText) {
                                throw ApiException("تدفق المحادثة لم يكتمل بشكل صحيح.")
                            }
                            emit(ChatStreamEvent.Completed(provenance ?: throw ApiException("مصدر النموذج مفقود.")))
                            sawDone = true
                        }
                    }
                    eventName = "message"
                }

                while (!sawDone) {
                    val rawLine = readLine(input) ?: break
                    totalBytes += rawLine.size + 1
                    if (totalBytes > MAX_STREAM_BYTES) throw ApiException("تدفق المحادثة تجاوز الحد المسموح.")
                    val line = decodeUtf8(rawLine).removeSuffix("\r")
                    if (line.isEmpty()) {
                        dispatch()
                        continue
                    }
                    if (line.startsWith(":")) continue
                    val colon = line.indexOf(':')
                    val field = if (colon < 0) line else line.substring(0, colon)
                    var value = if (colon < 0) "" else line.substring(colon + 1)
                    if (value.startsWith(" ")) value = value.substring(1)
                    when (field) {
                        "event" -> {
                            if (value.length > MAX_EVENT_NAME_CHARS) throw ApiException("اسم حدث SSE طويل جدًا.")
                            eventName = value.ifEmpty { "message" }
                        }
                        "data" -> dataLines += value
                    }
                }
                if (!sawDone) throw ApiException("انتهى تدفق المحادثة دون حدث إكمال.")
            }

            private fun readLine(input: InputStream): ByteArray? {
                val bytes = ByteArrayOutputStream()
                while (true) {
                    val value = input.read()
                    if (value < 0) return if (bytes.size() == 0) null else bytes.toByteArray()
                    if (value == '\n'.code) return bytes.toByteArray()
                    if (bytes.size() >= MAX_LINE_BYTES) throw ApiException("سطر SSE تجاوز الحد المسموح.")
                    bytes.write(value)
                }
            }

            private const val MAX_STREAM_BYTES = 1_200_000
            private const val MAX_OUTPUT_BYTES = 1_000_000
            private const val MAX_RESULT_BYTES = 64_000
            private const val MAX_LINE_BYTES = 64_000
            private const val MAX_EVENT_NAME_CHARS = 128
            private val SAFE_CODE = Regex("^[A-Z0-9_]{3,64}$")
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val TOKEN_PATTERN = Regex("^[A-Za-z0-9_-]{30,512}$")
        val COUNT_PATTERN = Regex("^\\d{1,30}$")
        const val MAX_JSON_BYTES = 64_000
        const val MAX_MESSAGES = 40
        const val MAX_CONVERSATION_CHARS = 40_000
    }
}
