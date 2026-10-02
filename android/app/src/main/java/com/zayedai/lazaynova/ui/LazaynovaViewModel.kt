package com.zayedai.lazaynova.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zayedai.lazaynova.BuildConfig
import com.zayedai.lazaynova.data.ApiLazaynovaRepository
import com.zayedai.lazaynova.data.CapabilitySnapshot
import com.zayedai.lazaynova.data.FeatureAvailability
import com.zayedai.lazaynova.data.LazaynovaApi
import com.zayedai.lazaynova.data.LazaynovaRepository
import com.zayedai.lazaynova.data.MockDagRunStatus
import com.zayedai.lazaynova.data.MockDagSnapshot
import com.zayedai.lazaynova.data.MockLazaynovaRepository
import com.zayedai.lazaynova.data.MockPreviewRepository
import com.zayedai.lazaynova.data.TaskFeature
import com.zayedai.lazaynova.data.evaluateFeatureAvailability
import com.zayedai.lazaynova.security.EncryptedSessionStore
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LazaynovaViewModel(application: Application) : AndroidViewModel(application), LazaynovaScreenActions {
    private val repository: LazaynovaRepository = if (BuildConfig.USE_MOCK_DATA) {
        MockLazaynovaRepository()
    } else {
        ApiLazaynovaRepository()
    }
    private val mockMode = BuildConfig.USE_MOCK_DATA
    private val sessionStore = EncryptedSessionStore(application)
    private val mutableState = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = mutableState.asStateFlow()

    private var authenticatedSession: LazaynovaApi.Session? = null
    private var streamJob: Job? = null
    private var mockDagJob: Job? = null

    init {
        if (mockMode) {
            mutableState.update {
                it.copy(
                    baseUrl = "https://mock.lazaynova.invalid",
                    email = "preview@lazaynova.test",
                    sessionLoaded = true,
                )
            }
        } else {
            viewModelScope.launch {
                val saved = withContext(Dispatchers.IO) { sessionStore.load() }
                authenticatedSession = saved?.let { LazaynovaApi.Session(it.baseUrl, it.bearerToken, "") }
                mutableState.update {
                    it.copy(
                        baseUrl = saved?.baseUrl.orEmpty(),
                        isAuthenticated = saved != null,
                        sessionLoaded = true,
                    )
                }
                saved?.let {
                    val session = authenticatedSession ?: return@let
                    loadUsage(session)
                    loadCapabilities(session)
                }
            }
        }
    }

    fun setBaseUrl(value: String) = mutableState.update { it.copy(baseUrl = value, error = null) }
    fun setEmail(value: String) = mutableState.update { it.copy(email = value, error = null) }
    fun setPassword(value: String) = mutableState.update { it.copy(password = value, error = null) }
    override fun setDraft(value: String) = mutableState.update { it.copy(draft = value.take(MAX_PROMPT_CHARS), error = null) }

    override fun newChat() {
        if (streamJob?.isActive == true) cancelGeneration()
        mutableState.update { it.copy(messages = emptyList(), draft = "", provenance = null, error = null) }
    }

    override fun refreshUsage() {
        val session = authenticatedSession ?: return
        viewModelScope.launch { loadUsage(session) }
    }

    private suspend fun loadUsage(session: LazaynovaApi.Session) {
        mutableState.update { it.copy(isUsageLoading = true, usageError = null) }
        try {
            val usage = repository.getUsage(session)
            mutableState.update { it.copy(usageSummary = usage, isUsageLoading = false, usageError = null) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val message = if (error is LazaynovaApi.ApiException) error.message else "تعذّر تحميل ملخص الاستخدام من الخادم."
            mutableState.update { it.copy(isUsageLoading = false, usageError = message) }
        }
    }

    override fun refreshCapabilities() {
        val session = authenticatedSession ?: return
        viewModelScope.launch { loadCapabilities(session) }
    }

    override fun startMockDagPreview() {
        val previewRepository = repository as? MockPreviewRepository ?: return
        mockDagJob?.cancel()
        mockDagJob = viewModelScope.launch {
            mutableState.update { it.copy(isMockDagRunning = true, mockDagSnapshot = null) }
            try {
                previewRepository.streamDagPreview().collect { snapshot ->
                    mutableState.update { it.copy(mockDagSnapshot = snapshot) }
                }
            } catch (error: CancellationException) {
                throw error
            } finally {
                mutableState.update { it.copy(isMockDagRunning = false) }
            }
        }
    }

    override fun approveMockDagPreview() {
        val previewRepository = repository as? MockPreviewRepository ?: return
        val pending = mutableState.value.mockDagSnapshot ?: return
        if (pending.status != MockDagRunStatus.WAITING_APPROVAL) return
        mockDagJob?.cancel()
        mockDagJob = viewModelScope.launch {
            mutableState.update { it.copy(isMockDagRunning = true) }
            try {
                previewRepository.approveDagPreview(pending.runId).collect { snapshot ->
                    mutableState.update { it.copy(mockDagSnapshot = snapshot) }
                }
            } catch (error: CancellationException) {
                throw error
            } finally {
                mutableState.update { it.copy(isMockDagRunning = false) }
            }
        }
    }

    private suspend fun loadCapabilities(session: LazaynovaApi.Session) {
        mutableState.update { it.copy(isCapabilitiesLoading = true, capabilitiesError = null) }
        try {
            val capabilities = repository.getCapabilities(session)
            mutableState.update { it.copy(capabilitySnapshot = capabilities, isCapabilitiesLoading = false, capabilitiesError = null) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val message = if (error is LazaynovaApi.ApiException) error.message else "تعذّر تحميل الصلاحيات والحصص من الخادم."
            mutableState.update { it.copy(isCapabilitiesLoading = false, capabilitiesError = message) }
        }
    }

    fun login() {
        val request = mutableState.value
        if (request.isLoading) return
        mutableState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            try {
                val session = repository.createSession(request.baseUrl, request.email, request.password)
                if (!mockMode) withContext(Dispatchers.IO) { sessionStore.save(session.baseUrl, session.bearerToken) }
                authenticatedSession = session
                mutableState.update {
                    it.copy(isAuthenticated = true, isLoading = false, password = "", messages = emptyList(), error = null)
                }
                loadUsage(session)
                loadCapabilities(session)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = if (error is LazaynovaApi.ApiException) error.message else "تعذّر تسجيل الدخول إلى الخادم."
                mutableState.update { it.copy(isLoading = false, error = message) }
            }
        }
    }

    override fun sendMessage() {
        if (streamJob?.isActive == true) return
        val current = mutableState.value
        if (current.isSigningOut) return
        val chatStatus = evaluateFeatureAvailability(
            TaskFeature("chat", "محادثة نصية", "CHAT", supportedByClient = true),
            current.capabilitySnapshot,
        )
        if (chatStatus.availability != FeatureAvailability.AVAILABLE) {
            mutableState.update { it.copy(error = chatStatus.explanation) }
            return
        }
        val session = authenticatedSession ?: run {
            mutableState.update { it.copy(error = "سجّل الدخول للمتابعة.") }
            return
        }
        val prompt = current.draft.trim()
        if (prompt.isEmpty()) return
        if (prompt.length > MAX_PROMPT_CHARS) {
            mutableState.update { it.copy(error = "الرسالة أطول من الحد المسموح.") }
            return
        }

        val conversation = boundedConversation(current.messages, prompt)
        val uiMessages = conversation.map { UiChatMessage(UUID.randomUUID().toString(), it.role, it.content) }
            .toMutableList()
        uiMessages += UiChatMessage(UUID.randomUUID().toString(), "assistant", "", isStreaming = true)
        mutableState.update {
            it.copy(messages = uiMessages, draft = "", isSending = true, error = null, provenance = null)
        }

        streamJob = viewModelScope.launch {
            var completed = false
            try {
                repository.streamChat(session, conversation).collect { event ->
                    when (event) {
                        is LazaynovaApi.ChatStreamEvent.TextDelta -> mutableState.update { state ->
                            val messages = state.messages.toMutableList()
                            val last = messages.lastOrNull()
                            if (last?.role == "assistant" && last.isStreaming) {
                                messages[messages.lastIndex] = last.copy(content = last.content + event.content)
                            }
                            state.copy(messages = messages)
                        }
                        is LazaynovaApi.ChatStreamEvent.Completed -> {
                            completed = true
                            mutableState.update { state ->
                                val messages = state.messages.toMutableList()
                                val last = messages.lastOrNull()
                                if (last?.role == "assistant") messages[messages.lastIndex] = last.copy(isStreaming = false)
                                state.copy(
                                    messages = messages,
                                    isSending = false,
                                    provenance = "${event.provenance.provider} · ${event.provenance.model}",
                                )
                            }
                        }
                    }
                }
                if (!completed) throw LazaynovaApi.ApiException("لم يصل تأكيد اكتمال من الخادم.")
                loadUsage(session)
                loadCapabilities(session)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                mutableState.update { state ->
                    val messages = state.messages.toMutableList()
                    val last = messages.lastOrNull()
                    if (last?.role == "assistant" && last.isStreaming) {
                        if (last.content.isBlank()) messages.removeAt(messages.lastIndex)
                        else messages[messages.lastIndex] = last.copy(isStreaming = false, isIncomplete = true)
                    }
                    val lastUserIndex = messages.indexOfLast { it.role == "user" }
                    if (lastUserIndex >= 0) messages[lastUserIndex] = messages[lastUserIndex].copy(excludeFromHistory = true)
                    state.copy(
                        messages = messages,
                        isSending = false,
                        error = error.message ?: "تعذّر إكمال المحادثة.",
                    )
                }
            }
        }
    }

    override fun cancelGeneration() {
        streamJob?.cancel()
        streamJob = null
        mutableState.update { state ->
            val messages = state.messages.toMutableList()
            val last = messages.lastOrNull()
            if (last?.role == "assistant" && last.isStreaming) {
                if (last.content.isBlank()) messages.removeAt(messages.lastIndex)
                else messages[messages.lastIndex] = last.copy(isStreaming = false, isIncomplete = true)
            }
            val lastUserIndex = messages.indexOfLast { it.role == "user" }
            if (lastUserIndex >= 0) messages[lastUserIndex] = messages[lastUserIndex].copy(excludeFromHistory = true)
            state.copy(messages = messages, isSending = false, error = "أوقفتَ تدفق الإجابة.")
        }
    }

    override fun signOut() {
        streamJob?.cancel()
        streamJob = null
        mockDagJob?.cancel()
        mockDagJob = null
        mutableState.update { it.copy(isSigningOut = true, error = null) }
        viewModelScope.launch {
            try {
                if (!mockMode) withContext(Dispatchers.IO) { sessionStore.clear() }
                authenticatedSession = null
                mutableState.update {
                    ChatUiState(
                        sessionLoaded = true,
                        baseUrl = if (mockMode) "https://mock.lazaynova.invalid" else "",
                        email = if (mockMode) "preview@lazaynova.test" else "",
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                mutableState.update { it.copy(isSigningOut = false, isSending = false, error = error.message ?: "تعذّر حذف الجلسة الآمنة.") }
            }
        }
    }

    private fun boundedConversation(history: List<UiChatMessage>, prompt: String): List<LazaynovaApi.ChatMessage> {
        val all = history.asSequence()
            .filter { !it.isIncomplete && !it.excludeFromHistory && it.content.isNotBlank() }
            .map { LazaynovaApi.ChatMessage(it.role, it.content) }
            .toList() + LazaynovaApi.ChatMessage("user", prompt)
        var start = (all.size - MAX_MESSAGES).coerceAtLeast(0)
        if (all[start].role == "assistant") start++
        while (start < all.lastIndex && all.drop(start).sumOf { it.content.length } > MAX_CONVERSATION_CHARS) {
            start++
            if (start < all.lastIndex && all[start].role == "assistant") start++
        }
        return all.drop(start)
    }

    data class ChatUiState(
        val sessionLoaded: Boolean = false,
        val isAuthenticated: Boolean = false,
        val isLoading: Boolean = false,
        val isSending: Boolean = false,
        val isSigningOut: Boolean = false,
        val baseUrl: String = "",
        val email: String = "",
        val password: String = "",
        val draft: String = "",
        val messages: List<UiChatMessage> = emptyList(),
        val provenance: String? = null,
        val usageSummary: LazaynovaApi.UsageSummary? = null,
        val isUsageLoading: Boolean = false,
        val capabilitySnapshot: CapabilitySnapshot? = null,
        val isCapabilitiesLoading: Boolean = false,
        val capabilitiesError: String? = null,
        val mockDagSnapshot: MockDagSnapshot? = null,
        val isMockDagRunning: Boolean = false,
        val usageError: String? = null,
        val error: String? = null,
    )

    data class UiChatMessage(
        val id: String,
        val role: String,
        val content: String,
        val isStreaming: Boolean = false,
        val isIncomplete: Boolean = false,
        val excludeFromHistory: Boolean = false,
    )

    private companion object {
        const val MAX_MESSAGES = 40
        const val MAX_CONVERSATION_CHARS = 40_000
        const val MAX_PROMPT_CHARS = 20_000
    }
}
