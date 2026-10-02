package com.zayedai.lazaynova.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zayedai.lazaynova.data.LazaynovaApi
import com.zayedai.lazaynova.security.EncryptedSessionStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

class LazaynovaViewModel(application: Application) : AndroidViewModel(application) {
    private val api = LazaynovaApi()
    private val sessionStore = EncryptedSessionStore(application)
    private val mutableState = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = mutableState.asStateFlow()

    private var authenticatedSession: LazaynovaApi.Session? = null
    private var streamJob: Job? = null

    init {
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
        }
    }

    fun setBaseUrl(value: String) = mutableState.update { it.copy(baseUrl = value, error = null) }
    fun setEmail(value: String) = mutableState.update { it.copy(email = value, error = null) }
    fun setPassword(value: String) = mutableState.update { it.copy(password = value, error = null) }
    fun setDraft(value: String) = mutableState.update { it.copy(draft = value.take(MAX_PROMPT_CHARS), error = null) }

    fun login() {
        val request = mutableState.value
        if (request.isLoading) return
        mutableState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            try {
                val session = api.createSession(request.baseUrl, request.email, request.password)
                withContext(Dispatchers.IO) { sessionStore.save(session.baseUrl, session.bearerToken) }
                authenticatedSession = session
                mutableState.update {
                    it.copy(isAuthenticated = true, isLoading = false, password = "", messages = emptyList(), error = null)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = if (error is LazaynovaApi.ApiException) error.message else "تعذّر تسجيل الدخول إلى الخادم."
                mutableState.update { it.copy(isLoading = false, error = message) }
            }
        }
    }

    fun sendMessage() {
        if (streamJob?.isActive == true) return
        val current = mutableState.value
        if (current.isSigningOut) return
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
                api.streamChat(session, conversation).collect { event ->
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

    fun cancelGeneration() {
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

    fun signOut() {
        streamJob?.cancel()
        streamJob = null
        mutableState.update { it.copy(isSigningOut = true, error = null) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { sessionStore.clear() }
                authenticatedSession = null
                mutableState.update { ChatUiState(sessionLoaded = true) }
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
