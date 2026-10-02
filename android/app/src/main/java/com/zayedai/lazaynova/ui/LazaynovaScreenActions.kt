package com.zayedai.lazaynova.ui

/** Side-effect boundary lets Compose previews render the same screens with no real account or server. */
interface LazaynovaScreenActions {
    fun newChat()
    fun refreshUsage()
    fun refreshCapabilities()
    fun startMockDagPreview()
    fun approveMockDagPreview()
    fun setDraft(value: String)
    fun sendMessage()
    fun cancelGeneration()
    fun signOut()
}
