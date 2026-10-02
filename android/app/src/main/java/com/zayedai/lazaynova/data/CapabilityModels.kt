package com.zayedai.lazaynova.data

import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset

/** Authenticated backend state. It is never synthesized in the live repository. */
data class CapabilitySnapshot(val capabilities: List<CapabilityGrantSnapshot>) {
    fun capability(name: String): CapabilityGrantSnapshot? = capabilities.firstOrNull { it.capability == name }
}

data class CapabilityGrantSnapshot(
    val capability: String,
    val granted: Boolean,
    val ready: Boolean,
    val toolGrants: List<ToolGrantSnapshot>,
)

data class ToolGrantSnapshot(
    val name: String,
    val granted: Boolean,
    val usage: ToolUsageSnapshot?,
)

/** A point-in-time server count; remaining calls are derived client-side and are explicitly estimates. */
data class ToolUsageSnapshot(
    val callsPerMinute: Int,
    val usedThisMinute: Int,
    val minuteResetAt: Instant,
    val callsPerDay: Int,
    val usedToday: Int,
    val utcDayResetAt: Instant,
    val serverTime: Instant,
    val receivedAt: Instant = Instant.now(),
)

data class ToolQuotaEstimate(
    val minuteLimit: Int,
    val minuteUsed: Int,
    val minuteRemaining: Int,
    val dayLimit: Int,
    val dayUsed: Int,
    val dayRemaining: Int,
    val dailyProgress: Float,
    val nearDailyLimit: Boolean,
    val exhausted: Boolean,
    val nextUtcDayResetAt: Instant,
)

object ToolQuotaEstimator {
    fun estimate(snapshot: ToolUsageSnapshot, clientNow: Instant = Instant.now()): ToolQuotaEstimate {
        val elapsedSinceReceipt = Duration.between(snapshot.receivedAt, clientNow).toMillis().coerceAtLeast(0)
        val estimatedServerNow = snapshot.serverTime.plusMillis(elapsedSinceReceipt)
        val minuteUsed = if (estimatedServerNow >= snapshot.minuteResetAt) 0 else snapshot.usedThisMinute
        val dayUsed = if (estimatedServerNow >= snapshot.utcDayResetAt) 0 else snapshot.usedToday
        val nextUtcDayResetAt = if (estimatedServerNow >= snapshot.utcDayResetAt) {
            estimatedServerNow.atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
        } else {
            snapshot.utcDayResetAt
        }
        val minuteRemaining = (snapshot.callsPerMinute - minuteUsed).coerceAtLeast(0)
        val dayRemaining = (snapshot.callsPerDay - dayUsed).coerceAtLeast(0)
        val progress = if (snapshot.callsPerDay <= 0) 0f else (dayUsed.toFloat() / snapshot.callsPerDay).coerceIn(0f, 1f)
        return ToolQuotaEstimate(
            minuteLimit = snapshot.callsPerMinute,
            minuteUsed = minuteUsed,
            minuteRemaining = minuteRemaining,
            dayLimit = snapshot.callsPerDay,
            dayUsed = dayUsed,
            dayRemaining = dayRemaining,
            dailyProgress = progress,
            nearDailyLimit = snapshot.callsPerDay > 0 && dayUsed.toLong() * 10 >= snapshot.callsPerDay.toLong() * 9,
            exhausted = minuteRemaining == 0 || dayRemaining == 0,
            nextUtcDayResetAt = nextUtcDayResetAt,
        )
    }
}

enum class FeatureAvailability(val label: String) {
    AVAILABLE("متاح"),
    LACKS_CAPABILITY("يتطلب منح صلاحية"),
    BUDGET_EXHAUSTED("اكتملت الحصة"),
    UNSUPPORTED_CLIENT("غير مدعوم في العميل"),
    BACKEND_UNAVAILABLE("الخادم غير جاهز"),
}

data class TaskFeature(
    val key: String,
    val title: String,
    val capability: String?,
    val requiredTool: String? = null,
    val supportedByClient: Boolean,
    val permissionName: String? = null,
)

data class FeatureAvailabilityResult(
    val availability: FeatureAvailability,
    val explanation: String,
    val toolGrant: ToolGrantSnapshot? = null,
    val quota: ToolQuotaEstimate? = null,
)

fun evaluateFeatureAvailability(
    feature: TaskFeature,
    snapshot: CapabilitySnapshot?,
    now: Instant = Instant.now(),
): FeatureAvailabilityResult {
    if (!feature.supportedByClient) {
        return FeatureAvailabilityResult(
            FeatureAvailability.UNSUPPORTED_CLIENT,
            "واجهة الهاتف لا تنفّذ هذه المهمة بعد. لن يُرسل طلب، حتى لو كانت الصلاحية ممنوحة.",
        )
    }
    if (feature.capability == null) {
        return FeatureAvailabilityResult(FeatureAvailability.UNSUPPORTED_CLIENT, "لا توجد واجهة خادمية موصولة بهذه المهمة.")
    }
    val capability = snapshot?.capability(feature.capability)
        ?: return FeatureAvailabilityResult(FeatureAvailability.BACKEND_UNAVAILABLE, "تعذّر تحميل حالة الصلاحيات من الخادم المصادق عليه.")
    if (!capability.granted) {
        return FeatureAvailabilityResult(
            FeatureAvailability.LACKS_CAPABILITY,
            "الحساب لا يملك صلاحية ${feature.capability}. اطلب منحها من مشغّل الخادم.",
        )
    }
    if (!capability.ready) {
        return FeatureAvailabilityResult(
            FeatureAvailability.BACKEND_UNAVAILABLE,
            "الصلاحية ممنوحة، لكن الخادم لا يعلن جاهزية ${feature.capability} حاليًا.",
        )
    }
    if (feature.requiredTool != null) {
        val toolGrant = capability.toolGrants.firstOrNull { it.name == feature.requiredTool }
        if (toolGrant?.granted != true) {
            return FeatureAvailabilityResult(
                FeatureAvailability.LACKS_CAPABILITY,
                "تتطلب المهمة منح أداة ${feature.requiredTool} بصورة مستقلة من مشغّل الخادم.",
                toolGrant = toolGrant,
            )
        }
        val quota = toolGrant.usage?.let { ToolQuotaEstimator.estimate(it, now) }
        if (quota?.exhausted == true) {
            return FeatureAvailabilityResult(
                FeatureAvailability.BUDGET_EXHAUSTED,
                "اكتملت الحصة الحالية لهذه الأداة. تُعاد الحصة اليومية عند منتصف الليل UTC.",
                toolGrant = toolGrant,
                quota = quota,
            )
        }
        if (toolGrant.usage == null) {
            return FeatureAvailabilityResult(
                FeatureAvailability.BACKEND_UNAVAILABLE,
                "لم يرسل الخادم عدادات الحصة؛ لا يمكن تقدير المتبقي بأمان.",
                toolGrant = toolGrant,
            )
        }
        return FeatureAvailabilityResult(FeatureAvailability.AVAILABLE, "الصلاحية والأداة والجاهزية متاحة.", toolGrant, quota)
    }
    return FeatureAvailabilityResult(FeatureAvailability.AVAILABLE, "الصلاحية والجاهزية متاحتان.")
}
