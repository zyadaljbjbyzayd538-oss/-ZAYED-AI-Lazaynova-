package com.zayedai.lazaynova.data

import java.time.Instant
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapabilityModelsTest {
    @Test
    fun dailyQuotaUsesServerSnapshotAndWarnsAtNinetyPercent() {
        val snapshot = usageSnapshot(
            serverTime = "2026-10-02T12:00:00Z",
            receivedAt = "2026-10-02T12:00:00Z",
            utcDayResetAt = "2026-10-03T00:00:00Z",
            usedToday = 180,
            dayLimit = 200,
        )

        val estimate = ToolQuotaEstimator.estimate(snapshot, Instant.parse("2026-10-02T12:00:01Z"))

        assertEquals(20, estimate.dayRemaining)
        assertEquals(0.9f, estimate.dailyProgress, 0.0001f)
        assertTrue(estimate.nearDailyLimit)
        assertFalse(estimate.exhausted)
        assertEquals(Instant.parse("2026-10-03T00:00:00Z"), estimate.nextUtcDayResetAt)
    }

    @Test
    fun dailyUsageResetsAtTheServerProvidedUtcMidnight() {
        val snapshot = usageSnapshot(
            serverTime = "2026-10-02T23:59:30Z",
            receivedAt = "2026-10-02T23:59:30Z",
            minuteResetAt = "2026-10-03T00:00:00Z",
            utcDayResetAt = "2026-10-03T00:00:00Z",
            usedMinute = 8,
            usedToday = 200,
            dayLimit = 200,
        )

        val estimate = ToolQuotaEstimator.estimate(snapshot, Instant.parse("2026-10-03T00:00:05Z"))

        assertEquals(0, estimate.dayUsed)
        assertEquals(200, estimate.dayRemaining)
        assertEquals(Instant.parse("2026-10-04T00:00:00Z"), estimate.nextUtcDayResetAt)
        assertFalse(estimate.exhausted)
    }

    @Test
    fun minuteCounterResetsIndependentlyOfDailyCounter() {
        val snapshot = usageSnapshot(
            serverTime = "2026-10-02T12:00:30Z",
            receivedAt = "2026-10-02T12:00:30Z",
            minuteResetAt = "2026-10-02T12:01:00Z",
            utcDayResetAt = "2026-10-03T00:00:00Z",
            usedMinute = 20,
            usedToday = 17,
        )

        val estimate = ToolQuotaEstimator.estimate(snapshot, Instant.parse("2026-10-02T12:01:02Z"))

        assertEquals(0, estimate.minuteUsed)
        assertEquals(20, estimate.minuteRemaining)
        assertEquals(17, estimate.dayUsed)
    }

    @Test
    fun capabilityAndToolGrantsDriveAvailability() {
        val feature = TaskFeature("research", "Research", "WEB_RESEARCH", "web.search", supportedByClient = true)
        val now = Instant.parse("2026-10-02T12:00:30Z")
        val available = capability("WEB_RESEARCH", true, true, toolGranted = true, usedToday = 5)
        val ungranted = capability("WEB_RESEARCH", false, true, toolGranted = true, usedToday = 5)
        val toolMissing = capability("WEB_RESEARCH", true, true, toolGranted = false, usedToday = 5)
        val exhausted = capability("WEB_RESEARCH", true, true, toolGranted = true, usedToday = 200)
        val notReady = capability("WEB_RESEARCH", true, false, toolGranted = true, usedToday = 5)

        assertEquals(FeatureAvailability.AVAILABLE, evaluateFeatureAvailability(feature, available, now).availability)
        assertEquals(FeatureAvailability.LACKS_CAPABILITY, evaluateFeatureAvailability(feature, ungranted, now).availability)
        assertEquals(FeatureAvailability.LACKS_CAPABILITY, evaluateFeatureAvailability(feature, toolMissing, now).availability)
        assertEquals(FeatureAvailability.BUDGET_EXHAUSTED, evaluateFeatureAvailability(feature, exhausted, now).availability)
        assertEquals(FeatureAvailability.BACKEND_UNAVAILABLE, evaluateFeatureAvailability(feature, notReady, now).availability)
        assertEquals(FeatureAvailability.BACKEND_UNAVAILABLE, evaluateFeatureAvailability(feature, null, now).availability)
    }

    @Test
    fun unsupportedClientIsNotOverriddenByBackendGrants() {
        val feature = TaskFeature("media", "Media", "WEB_RESEARCH", "web.search", supportedByClient = false)
        val result = evaluateFeatureAvailability(feature, capability("WEB_RESEARCH", true, true, true, 0))

        assertEquals(FeatureAvailability.UNSUPPORTED_CLIENT, result.availability)
        assertTrue(result.explanation.contains("لن يُرسل"))
    }

    @Test
    fun mockRepositoryReturnsOnlyExplicitLocalFixtures() = runBlocking {
        val repository = MockLazaynovaRepository()
        val session = repository.createSession("", "preview@lazaynova.test", "not-persisted")
        val capabilities = repository.getCapabilities(session)
        val usage = repository.getUsage(session)
        val events = repository.streamChat(session, listOf(LazaynovaApi.ChatMessage("user", "preview"))).toList()

        assertEquals("https://mock.lazaynova.invalid", session.baseUrl)
        assertEquals(200, capabilities.capability("WEB_RESEARCH")?.toolGrants?.first()?.usage?.usedToday ?: -1)
        assertEquals("12", usage.requestCount)
        val streamedText = events.filterIsInstance<LazaynovaApi.ChatStreamEvent.TextDelta>().joinToString("") { it.content }
        assertTrue(streamedText.startsWith("[محاكاة محلية]"))
        assertEquals("mock", (events.last() as LazaynovaApi.ChatStreamEvent.Completed).provenance.provider)
    }

    @Test
    fun mockTextStreamEmitsIncrementalWhitespacePreservingChunks() = runBlocking {
        val repository = MockLazaynovaRepository(tokenDelayMillis = 0)
        val chunks = repository.streamText(listOf(LazaynovaApi.ChatMessage("user", "preview"))).toList()
        val text = chunks.joinToString("")

        assertTrue(chunks.size > 3)
        assertTrue(chunks.all { it.isNotEmpty() })
        assertTrue(text.startsWith("[محاكاة محلية]"))
        assertTrue(text.contains("لم يُرسل نصك إلى أي خادم"))
    }

    @Test
    fun mockDagEmitsProgressWaitsForLocalApprovalAndCompletes() = runBlocking {
        val repository = MockLazaynovaRepository(previewStepDelayMillis = 0)
        val snapshots = repository.streamDagPreview().toList()

        assertEquals(
            listOf(MockDagRunStatus.QUEUED, MockDagRunStatus.RUNNING, MockDagRunStatus.WAITING_APPROVAL),
            snapshots.map { it.status },
        )
        val waiting = snapshots.last()
        assertFalse(waiting.approvalIsSimulated)
        assertEquals(FeatureAvailability.UNSUPPORTED_CLIENT, waiting.nodes.first { it.id == "file" }.availability)
        assertEquals(FeatureAvailability.BACKEND_UNAVAILABLE, waiting.nodes.first { it.id == "model" }.availability)
        assertTrue(repository.approveDagPreview("not-a-mock-run").toList().isEmpty())

        val approved = repository.approveDagPreview(waiting.runId).toList()
        assertEquals(listOf(MockDagRunStatus.RUNNING, MockDagRunStatus.COMPLETED), approved.map { it.status })
        assertTrue(approved.all { it.approvalIsSimulated })
        assertEquals(1f, approved.last().progress, 0f)
    }

    private fun capability(
        name: String,
        granted: Boolean,
        ready: Boolean,
        toolGranted: Boolean,
        usedToday: Int,
    ) = CapabilitySnapshot(
        listOf(
            CapabilityGrantSnapshot(
                name,
                granted,
                ready,
                listOf(ToolGrantSnapshot("web.search", toolGranted, usageSnapshot(usedToday = usedToday))),
            ),
        ),
    )

    private fun usageSnapshot(
        serverTime: String = "2026-10-02T12:00:00Z",
        receivedAt: String = serverTime,
        minuteResetAt: String = "2026-10-02T12:01:00Z",
        utcDayResetAt: String = "2026-10-03T00:00:00Z",
        usedMinute: Int = 4,
        usedToday: Int,
        dayLimit: Int = 200,
    ) = ToolUsageSnapshot(
        callsPerMinute = 20,
        usedThisMinute = usedMinute,
        minuteResetAt = Instant.parse(minuteResetAt),
        callsPerDay = dayLimit,
        usedToday = usedToday,
        utcDayResetAt = Instant.parse(utcDayResetAt),
        serverTime = Instant.parse(serverTime),
        receivedAt = Instant.parse(receivedAt),
    )
}
