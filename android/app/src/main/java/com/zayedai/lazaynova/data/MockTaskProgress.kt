package com.zayedai.lazaynova.data

enum class MockDagRunStatus {
    QUEUED,
    RUNNING,
    WAITING_APPROVAL,
    COMPLETED,
}

enum class MockDagNodeStatus {
    PENDING,
    RUNNING,
    WAITING_APPROVAL,
    COMPLETED,
    BLOCKED,
}

data class MockDagNodeSnapshot(
    val id: String,
    val title: String,
    val status: MockDagNodeStatus,
    val availability: FeatureAvailability,
)

data class MockDagSnapshot(
    val runId: String,
    val status: MockDagRunStatus,
    val progress: Float,
    val nodes: List<MockDagNodeSnapshot>,
    val approvalIsSimulated: Boolean = false,
)

/** Mock-only progress contract; live repositories intentionally do not implement it. */
interface MockPreviewRepository {
    fun streamDagPreview(): kotlinx.coroutines.flow.Flow<MockDagSnapshot>
    fun approveDagPreview(runId: String): kotlinx.coroutines.flow.Flow<MockDagSnapshot>
}
