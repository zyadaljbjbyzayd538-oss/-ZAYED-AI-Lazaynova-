package com.zayedai.lazaynova.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zayedai.lazaynova.BuildConfig
import com.zayedai.lazaynova.data.CapabilityGrantSnapshot
import com.zayedai.lazaynova.data.CapabilitySnapshot
import com.zayedai.lazaynova.data.FeatureAvailability
import com.zayedai.lazaynova.data.FeatureAvailabilityResult
import com.zayedai.lazaynova.data.LazaynovaApi
import com.zayedai.lazaynova.data.MockDagNodeSnapshot
import com.zayedai.lazaynova.data.MockDagNodeStatus
import com.zayedai.lazaynova.data.MockDagRunStatus
import com.zayedai.lazaynova.data.MockDagSnapshot
import com.zayedai.lazaynova.data.TaskFeature
import com.zayedai.lazaynova.data.ToolGrantSnapshot
import com.zayedai.lazaynova.data.ToolQuotaEstimator
import com.zayedai.lazaynova.data.ToolUsageSnapshot
import com.zayedai.lazaynova.data.evaluateFeatureAvailability
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class WorkspaceSection(val title: String, val symbol: String, val group: String) {
    CHAT("محادثة جديدة", "+", "الرئيسية"),
    HISTORY("المحادثات", "◷", "الرئيسية"),
    LIBRARY("المكتبة", "▤", "الرئيسية"),
    MEDIA("خزنة الوسائط", "◈", "الرئيسية"),
    DOCUMENTS("المستندات المشفّرة", "▧", "الرئيسية"),
    SCHEDULED("المهام المجدولة", "◷", "الرئيسية"),
    WORKFLOWS("مخطط تدفقات العمل", "⌘", "المحرك المتقدم"),
    AGENTS("منسّق الوكلاء", "✦", "المحرك المتقدم"),
    MEMORY("الذاكرة", "◎", "المحرك المتقدم"),
    INTEGRATIONS("التكاملات والمنح", "⤴", "المحرك المتقدم"),
    PRIVACY("الأمان والخصوصية", "◇", "الإعدادات"),
    USAGE("الاستخدام والتكلفة", "◌", "الإعدادات"),
    SETTINGS("المظهر واللغة", "⚙", "الإعدادات"),
}

private enum class WorkspaceSheet { TASKS, QUICK_PANEL }

@Composable
fun LoadingScreen() {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text("جارٍ استعادة جلسة Lazaynova الآمنة")
    }
}

@Composable
fun LoginScreen(state: LazaynovaViewModel.ChatUiState, viewModel: LazaynovaViewModel) {
    Box(
        modifier = Modifier.fillMaxSize().background(workspaceBrush()),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 36.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            GlowingMark()
            Spacer(Modifier.height(12.dp))
            Text("Lazaynova", fontSize = 34.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text("ZAYED AI · خاص وآمن", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(10.dp))
            Text(
                if (BuildConfig.USE_MOCK_DATA) "وضع محاكاة محلي: لا اتصال بخادم ولا إرسال لبيانات الدخول أو الرسائل."
                else "سجّل الدخول إلى خادم Lazaynova الخاص بك. يختار الخادم مزود ونموذج المحادثة؛ لا يحتوي التطبيق على مفاتيح مزودين.",
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(28.dp))
            if (!BuildConfig.USE_MOCK_DATA) {
                OutlinedTextField(
                    value = state.baseUrl,
                    onValueChange = viewModel::setBaseUrl,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("عنوان الخادم HTTPS") },
                    placeholder = { Text("https://api.example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    enabled = !state.isLoading,
                )
                Spacer(Modifier.height(12.dp))
            }
            OutlinedTextField(
                value = state.email,
                onValueChange = viewModel::setEmail,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("البريد الإلكتروني") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                enabled = !state.isLoading,
            )
            if (!BuildConfig.USE_MOCK_DATA) {
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = state.password,
                    onValueChange = viewModel::setPassword,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("كلمة المرور") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { viewModel.login() }),
                    enabled = !state.isLoading,
                )
            }
            state.error?.let { ErrorNotice(it) }
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = viewModel::login,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isLoading && state.email.isNotBlank() &&
                    (BuildConfig.USE_MOCK_DATA || (state.baseUrl.isNotBlank() && state.password.isNotBlank())),
            ) {
                if (state.isLoading) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(if (BuildConfig.USE_MOCK_DATA) "دخول إلى المعاينة المحلية" else "تسجيل الدخول")
            }
            Spacer(Modifier.height(20.dp))
            Text(
                if (BuildConfig.USE_MOCK_DATA) "بيانات هذه النسخة تجريبية ومصطنعة، ولن تظهر كحالة حساب حقيقي."
                else "لا تُحفظ كلمة المرور. يُشفّر رمز الجلسة محليًا بمفتاح Android Keystore، ويُرسل عبر HTTPS فقط.",
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    state: LazaynovaViewModel.ChatUiState,
    actions: LazaynovaScreenActions,
    themeMode: LazaynovaThemeMode,
    onThemeModeChange: (LazaynovaThemeMode) -> Unit,
    mockMode: Boolean = BuildConfig.USE_MOCK_DATA,
    initiallyShowTaskSheet: Boolean = false,
) {
    var sectionName by rememberSaveable { mutableStateOf(WorkspaceSection.CHAT.name) }
    var sheet by rememberSaveable(initiallyShowTaskSheet) {
        mutableStateOf(if (initiallyShowTaskSheet) WorkspaceSheet.TASKS else null)
    }
    var navigationQuery by rememberSaveable { mutableStateOf("") }
    val drawerState = rememberDrawerState(initialValue = androidx.compose.material3.DrawerValue.Closed)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val section = WorkspaceSection.entries.firstOrNull { it.name == sectionName } ?: WorkspaceSection.CHAT

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = maxWidth > 1200.dp
        val medium = maxWidth >= 600.dp
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        ModalNavigationDrawer(
            drawerState = drawerState,
            gesturesEnabled = !wide,
            drawerContent = {
                if (!wide) {
                    ModalDrawerSheet(drawerContainerColor = MaterialTheme.colorScheme.surface) {
                        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                        NavigationPane(
                            selected = section,
                            query = navigationQuery,
                            onQueryChange = { navigationQuery = it },
                            onSelect = { selected ->
                                if (selected == WorkspaceSection.CHAT) actions.newChat()
                                sectionName = selected.name
                                scope.launch { drawerState.close() }
                            },
                        )
                        }
                    }
                }
            },
        ) {
            Row(modifier = Modifier.fillMaxSize().background(workspaceBrush())) {
                if (wide) {
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    NavigationPane(
                        selected = section,
                        query = navigationQuery,
                        onQueryChange = { navigationQuery = it },
                        onSelect = { selected ->
                            if (selected == WorkspaceSection.CHAT) actions.newChat()
                            sectionName = selected.name
                        },
                        modifier = Modifier.width(264.dp).fillMaxHeight(),
                    )
                    }
                } else if (medium) {
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    NavigationRail(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f)) {
                        WorkspaceSection.entries.take(5).forEach { item ->
                            NavigationRailItem(
                                selected = section == item,
                                onClick = {
                                    if (item == WorkspaceSection.CHAT) actions.newChat()
                                    sectionName = item.name
                                },
                                icon = { Text(item.symbol, fontSize = 18.sp) },
                                label = { Text(item.title.take(8), fontSize = 10.sp) },
                                alwaysShowLabel = false,
                            )
                        }
                    }
                    }
                }

                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                CenterWorkspace(
                    state = state,
                    actions = actions,
                    section = section,
                    themeMode = themeMode,
                    compact = !wide,
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                    onOpenTaskSheet = { sheet = WorkspaceSheet.TASKS },
                    onOpenQuickPanel = { sheet = WorkspaceSheet.QUICK_PANEL },
                    onThemeModeChange = onThemeModeChange,
                    onRefreshCapabilities = actions::refreshCapabilities,
                    mockMode = mockMode,
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                )
                }

                if (wide) {
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    QuickActionPanel(
                        state = state,
                        themeMode = themeMode,
                        onThemeModeChange = onThemeModeChange,
                        onRefreshUsage = actions::refreshUsage,
                        onSignOut = actions::signOut,
                        onRefreshCapabilities = actions::refreshCapabilities,
                        mockMode = mockMode,
                        modifier = Modifier.width(304.dp).fillMaxHeight(),
                    )
                    }
                }
            }
        }
        }

        val visibleSheet = sheet
        if (visibleSheet != null) {
            ModalBottomSheet(
                onDismissRequest = { sheet = null },
                sheetState = sheetState,
                containerColor = MaterialTheme.colorScheme.surface,
            ) {
                when (visibleSheet) {
                    WorkspaceSheet.TASKS -> TaskSelectionSheet(
                        state = state,
                        mockMode = mockMode,
                        onSelectChat = { actions.newChat(); sheet = null },
                        onStartMockDag = actions::startMockDagPreview,
                        onApproveMockDag = actions::approveMockDagPreview,
                    )
                    WorkspaceSheet.QUICK_PANEL -> QuickActionPanel(
                        state = state,
                        themeMode = themeMode,
                        onThemeModeChange = onThemeModeChange,
                        onRefreshUsage = actions::refreshUsage,
                        onSignOut = actions::signOut,
                        onRefreshCapabilities = actions::refreshCapabilities,
                        mockMode = mockMode,
                        compact = true,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CenterWorkspace(
    state: LazaynovaViewModel.ChatUiState,
    actions: LazaynovaScreenActions,
    section: WorkspaceSection,
    themeMode: LazaynovaThemeMode,
    compact: Boolean,
    onOpenDrawer: () -> Unit,
    onOpenTaskSheet: () -> Unit,
    onOpenQuickPanel: () -> Unit,
    onThemeModeChange: (LazaynovaThemeMode) -> Unit,
    onRefreshCapabilities: () -> Unit,
    mockMode: Boolean,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Lazaynova", fontWeight = FontWeight.SemiBold)
                        Text(
                            state.provenance?.let { "آخر نموذج: $it" } ?: "اختيار النموذج من الخادم",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    if (compact) IconButton(onClick = onOpenDrawer) { Text("☰", fontSize = 20.sp) }
                },
                actions = {
                    if (compact) IconButton(onClick = onOpenQuickPanel) { Text("◉", fontSize = 20.sp) }
                    IconButton(onClick = onOpenTaskSheet) { Text("＋", fontSize = 24.sp, color = MaterialTheme.colorScheme.primary) }
                    if (!compact) {
                        TextButton(onClick = actions::signOut, enabled = !state.isSigningOut) {
                            Text(if (state.isSigningOut) "جارٍ الخروج…" else "خروج")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (mockMode) MockModeBanner()
            when (section) {
                WorkspaceSection.CHAT -> ChatConversation(state, actions, onOpenTaskSheet, mockMode)
                WorkspaceSection.USAGE -> UsageDashboard(state, actions, onRefreshCapabilities, mockMode)
                WorkspaceSection.SETTINGS -> SettingsDashboard(themeMode, onThemeModeChange)
                WorkspaceSection.PRIVACY -> PrivacyDashboard()
                else -> FeaturePlaceholder(section)
            }
        }
    }
}

@Composable
private fun ChatConversation(
    state: LazaynovaViewModel.ChatUiState,
    actions: LazaynovaScreenActions,
    onOpenTaskSheet: () -> Unit,
    mockMode: Boolean,
) {
    val chatStatus = evaluateFeatureAvailability(chatFeature, state.capabilitySnapshot)
    val chatEnabled = chatStatus.availability == FeatureAvailability.AVAILABLE
    Column(modifier = Modifier.fillMaxSize()) {
        CompactUsageStrip(state.usageSummary, state.isUsageLoading, mockMode)
        if (state.messages.isEmpty()) {
            WelcomeHero(modifier = Modifier.weight(1f).fillMaxWidth())
        } else {
            val listState = rememberLazyListState()
            LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.content?.length) {
                if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                items(state.messages, key = { it.id }) { message -> MessageBubble(message) }
            }
        }
        state.error?.let { ErrorNotice(it, Modifier.padding(horizontal = 16.dp)) }
        FloatingComposer(state, actions, onOpenTaskSheet, chatEnabled, chatStatus.explanation)
    }
}

@Composable
private fun WelcomeHero(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(horizontal = 24.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        GlowingMark(modifier = Modifier.size(126.dp))
        Spacer(Modifier.height(16.dp))
        Text("مرحباً بك في Lazaynova 👋", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(
            "أنا مساعدك الذكي، جاهز لمساعدتك في أي شيء تتخيله أو تحتاجه.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "اكتب طلبك لبدء محادثة. سيظهر الرد تدريجيًا من الخادم؛ لا يختار التطبيق النموذج.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun FloatingComposer(
    state: LazaynovaViewModel.ChatUiState,
    actions: LazaynovaScreenActions,
    onOpenTaskSheet: () -> Unit,
    chatEnabled: Boolean,
    chatExplanation: String,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 1000.dp).align(Alignment.CenterHorizontally),
            shape = RoundedCornerShape(26.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.91f),
            tonalElevation = 5.dp,
            shadowElevation = 8.dp,
        ) {
            Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = state.draft,
                    onValueChange = actions::setDraft,
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("اسأل Lazaynova…") },
                    minLines = 1,
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { actions.sendMessage() }),
                    enabled = !state.isSending && chatEnabled,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onOpenTaskSheet, enabled = !state.isSending) { Text("＋", fontSize = 23.sp) }
                    IconButton(onClick = onOpenTaskSheet, enabled = !state.isSending) { Text("🎙", fontSize = 17.sp) }
                    Spacer(Modifier.weight(1f))
                    Text("${state.draft.length}/20000", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (state.isSending) {
                        CircularProgressIndicator(modifier = Modifier.size(19.dp), strokeWidth = 2.dp)
                        TextButton(onClick = actions::cancelGeneration) { Text("إيقاف") }
                    } else {
                        Button(onClick = actions::sendMessage, enabled = state.draft.isNotBlank() && chatEnabled) { Text("إرسال") }
                    }
                }
            }
        }
        Text(
            if (chatEnabled) "النص متاح · الملفات والكاميرا والصوت لم تُربط بعد" else chatExplanation,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 6.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun NavigationPane(
    selected: WorkspaceSection,
    query: String,
    onQueryChange: (String) -> Unit,
    onSelect: (WorkspaceSection) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxHeight().background(MaterialTheme.colorScheme.surface.copy(alpha = 0.96f)).padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GlowingMark(modifier = Modifier.size(48.dp))
            Column {
                Text("Lazaynova", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                Text("ZAYED AI · ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(14.dp))
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("بحث في التنقل") },
            leadingIcon = { Text("⌕") },
            singleLine = true,
        )
        Spacer(Modifier.height(12.dp))
        LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            WorkspaceSection.entries.groupBy { it.group }.forEach { (group, entries) ->
                val filtered = entries.filter { query.isBlank() || it.title.contains(query.trim(), ignoreCase = true) }
                if (filtered.isNotEmpty()) {
                    item(key = "group-$group") {
                        Text(
                            group,
                            modifier = Modifier.padding(start = 12.dp, top = 12.dp, bottom = 6.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    items(filtered, key = { it.name }) { item ->
                        NavigationDrawerItem(
                            label = { Text(item.title, maxLines = 1) },
                            selected = item == selected,
                            onClick = { onSelect(item) },
                            icon = { Text(item.symbol, fontSize = 17.sp) },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(14.dp),
                        )
                    }
                }
            }
        }
        HorizontalDivider(modifier = Modifier.padding(vertical = 10.dp))
        Text("السجل غير محفوظ بين الجلسات حاليًا", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun QuickActionPanel(
    state: LazaynovaViewModel.ChatUiState,
    themeMode: LazaynovaThemeMode,
    onThemeModeChange: (LazaynovaThemeMode) -> Unit,
    onRefreshUsage: () -> Unit,
    onSignOut: () -> Unit,
    onRefreshCapabilities: () -> Unit,
    mockMode: Boolean,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    Column(
        modifier = modifier.fillMaxHeight().verticalScroll(rememberScrollState())
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.92f))
            .padding(horizontal = 16.dp, vertical = if (compact) 10.dp else 18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("لوحة سريعة", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        GlassCard {
            Text("الحساب", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(state.email.ifBlank { "حساب الخادم" }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("نشر ذاتي · لا توجد خطة اشتراك متصلة", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        UsageCard(state, onRefreshUsage, mockMode)
        ToolQuotaCard(state, onRefreshCapabilities, mockMode)
        GlassCard {
            Text("اختصارات", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            QuickStatusRow("✦", "الوكيل", "المحادثة فقط موصولة")
            QuickStatusRow("▧", "المستندات", "واجهة الرفع غير موصولة")
            QuickStatusRow("◈", "الصور والوسائط", "غير مفعّلة")
            QuickStatusRow("🎙", "الصوت المباشر", "غير مفعّل")
        }
        GlassCard {
            Text("مظهر التطبيق", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            ThemeChooser(themeMode, onThemeModeChange)
        }
        TextButton(onClick = onSignOut) { Text("تسجيل الخروج") }
    }
}

@Composable
private fun CompactUsageStrip(usage: LazaynovaApi.UsageSummary?, loading: Boolean, mockMode: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            loading -> Text("جارٍ مزامنة الاستخدام…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            usage != null -> Text(
                (if (mockMode) "[محاكاة] " else "") + "${usage.inputTokens} إدخال · ${usage.outputTokens} إخراج · تقدير ${costLabel(usage.costMicrousd)} USD",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> Text("مؤشر الاستخدام غير متاح من الخادم", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun UsageCard(state: LazaynovaViewModel.ChatUiState, onRefresh: () -> Unit, mockMode: Boolean) {
    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text(if (mockMode) "استخدام تجريبي · رموز وتكلفة" else "الاستخدام المسجّل · رموز وتكلفة", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            TextButton(onClick = onRefresh, enabled = !state.isUsageLoading) { Text(if (state.isUsageLoading) "…" else "تحديث") }
        }
        when {
            state.isUsageLoading && state.usageSummary == null -> {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text("جارٍ جلب سجل الاستخدام…", style = MaterialTheme.typography.bodySmall)
            }
            state.usageSummary != null -> {
                val usage = state.usageSummary
                MetricRow("الرموز المُدخلة", usage.inputTokens)
                MetricRow("الرموز المُخرجة", usage.outputTokens)
                MetricRow("الطلبات المسجّلة", usage.requestCount)
                MetricRow("تكلفة تقديرية مسعّرة", "${costLabel(usage.costMicrousd)} USD")
                if (usage.unpricedRequestCount != "0") {
                    Text("${usage.unpricedRequestCount} طلب/طلبات بلا تسعير مؤكّد؛ الرقم ليس فاتورة ولا رصيدًا متبقيًا.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            else -> Text(state.usageError ?: "لا تتوفر بيانات استخدام من الخادم.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        HorizontalDivider(modifier = Modifier.padding(vertical = 6.dp))
        Text(
            if (mockMode) "أرقام رموز وتكلفة مصطنعة للمعاينة فقط."
            else "هذا ملخص الرموز والتكلفة، وليس عدادًا لحصص الأدوات أو رصيدًا ماليًا.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ToolQuotaCard(
    state: LazaynovaViewModel.ChatUiState,
    onRefresh: () -> Unit,
    mockMode: Boolean,
) {
    var now by remember(state.capabilitySnapshot) { mutableStateOf(Instant.now()) }
    LaunchedEffect(state.capabilitySnapshot) {
        if (state.capabilitySnapshot != null) {
            while (true) {
                now = Instant.now()
                delay(15_000)
            }
        }
    }
    GlassCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (mockMode) "حصص الأدوات · محاكاة" else "حصص الأدوات · تقدير", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            TextButton(onClick = onRefresh, enabled = !state.isCapabilitiesLoading) {
                Text(if (state.isCapabilitiesLoading) "…" else "مزامنة")
            }
        }
        when {
            state.isCapabilitiesLoading && state.capabilitySnapshot == null -> {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text("جارٍ جلب المنح والعدادات من الخادم…", style = MaterialTheme.typography.bodySmall)
            }
            state.capabilitySnapshot == null -> Text(
                state.capabilitiesError ?: "لم تصل لقطة حصص مصادق عليها؛ لا يمكن حساب المتبقي.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> {
                val tools = state.capabilitySnapshot.capabilities.flatMap { capability ->
                    capability.toolGrants.map { capability.capability to it }
                }
                if (tools.isEmpty()) {
                    Text("لم يُعد الخادم أي أدوات لهذا الحساب.", style = MaterialTheme.typography.bodySmall)
                } else {
                    tools.forEach { (capability, tool) ->
                        ToolQuotaRow(capability, tool, now)
                    }
                }
                state.capabilitiesError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        }
        Text(
            if (mockMode) "الأرقام تجريبية محلية وليست حالة حساب."
            else "المتبقي = الحد − العداد الحالي. تقدير لقطة الخادم؛ قد يتغير عند استخدام جلسة أخرى. إعادة التصفير اليومية عند 00:00 UTC. منفصل عن رموز وتكلفة /v1/usage.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ToolQuotaRow(capability: String, tool: ToolGrantSnapshot, now: Instant) {
    val usage = tool.usage
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        HorizontalDivider(modifier = Modifier.padding(vertical = 3.dp))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(tool.name, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(if (tool.granted) "منحة مفعّلة" else "منحة غير مفعّلة", style = MaterialTheme.typography.labelSmall, color = if (tool.granted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("${capability} · السجل لا يُعامل كتكلفة", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (usage == null) {
            Text("عداد الحصة غير متاح من API؛ لن نعرض رقمًا متبقيًا مختلقًا.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            val estimate = ToolQuotaEstimator.estimate(usage, now)
            Text("اليوم UTC: ${estimate.dayUsed}/${estimate.dayLimit} مستخدم · متبقٍ تقديري ${estimate.dayRemaining}", style = MaterialTheme.typography.bodySmall)
            LinearProgressIndicator(progress = { estimate.dailyProgress }, modifier = Modifier.fillMaxWidth())
            Text("الدقيقة الحالية: ${estimate.minuteUsed}/${estimate.minuteLimit} · متبقٍ ${estimate.minuteRemaining}", style = MaterialTheme.typography.bodySmall)
            Text("تجديد اليوم: ${utcDateTime(estimate.nextUtcDayResetAt)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (estimate.nearDailyLimit) {
                Text("تنبيه: استُهلك 90٪ أو أكثر من الحصة اليومية.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
            }
        }
    }
}

private fun utcDateTime(instant: Instant): String =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'").withZone(ZoneOffset.UTC).format(instant)

@Composable
private fun UsageDashboard(state: LazaynovaViewModel.ChatUiState, actions: LazaynovaScreenActions, onRefreshCapabilities: () -> Unit, mockMode: Boolean) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column {
                Text("الاستخدام والتكلفة", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text("ملخص خاص بحسابك من سجل الخادم.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = actions::refreshUsage) { Text("تحديث") }
        }
        UsageCard(state, actions::refreshUsage, mockMode)
        ToolQuotaCard(state, onRefreshCapabilities, mockMode)
        Text("ملخص الرموز/التكلفة منفصل عن حصص استدعاء الأدوات. التقدير لا يمثل رصيدًا ماليًا.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SettingsDashboard(themeMode: LazaynovaThemeMode, onThemeModeChange: (LazaynovaThemeMode) -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("الإعدادات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        GlassCard {
            Text("المظهر", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            ThemeChooser(themeMode, onThemeModeChange)
        }
        GlassCard {
            Text("اللغة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("العربية · RTL (متاحة)", color = MaterialTheme.colorScheme.primary)
            Text("واجهة English لم تُترجم بالكامل بعد.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        GlassCard {
            Text("الصوت والإشعارات", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("لا يوجد نموذج صوت أو إشعارات دفع موصولة؛ لم تُطلب أذونات النظام.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PrivacyDashboard() {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("الأمان والخصوصية", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        GlassCard {
            Text("حماية الجلسة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("رمز الجلسة مشفّر محليًا عبر Android Keystore. لا تُخزّن كلمة المرور، والاتصال بالخادم يقبل HTTPS فقط.")
        }
        GlassCard {
            Text("حدود البيانات", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("المحادثة الحالية محفوظة في ذاكرة التطبيق فقط. لا يوجد أرشيف محادثات أو ذاكرة دائمة في الواجهة الحالية.")
        }
        GlassCard {
            Text("الأدلة", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("يعرض التطبيق مصدر النموذج الذي أرجعه الخادم بعد اكتمال البث. لا يعرض سجل SHA-256 تفصيليًا بعد.")
        }
    }
}

@Composable
private fun FeaturePlaceholder(section: WorkspaceSection) {
    val detail = when (section) {
        WorkspaceSection.HISTORY -> "لا يوجد أرشيف دائم للمحادثات في التطبيق حتى الآن؛ فتح محادثة جديدة يمسح سجل الشاشة الحالية فقط."
        WorkspaceSection.LIBRARY -> "واجهة المكتبة والبحث في المستندات لم تُربط بعد بواجهات تخزين موثقة."
        WorkspaceSection.MEDIA -> "رفع الصور/الفيديو ومعالجتها غير متاح من تطبيق الهاتف حاليًا."
        WorkspaceSection.DOCUMENTS -> "الخادم يدعم أنواعًا محدودة من الملفات المشفّرة، لكن مسار الرفع في تطبيق الهاتف غير موصول."
        WorkspaceSection.SCHEDULED -> "لا توجد واجهة جدولة أو تشغيل تلقائي متصلة."
        WorkspaceSection.WORKFLOWS -> "توجد واجهات تدفقات عمل في الخادم، لكن محرر DAG المرئي غير مدمج في تطبيق الهاتف."
        WorkspaceSection.AGENTS -> "لا تعرض هذه الشاشة وكيلًا منفذًا؛ واجهة تنسيق الوكلاء غير متصلة بعد."
        WorkspaceSection.MEMORY -> "الذاكرة طويلة الأمد وعمليات العرض/الحذف غير منفذة. لا يتم إنشاء عقد ذاكرة هنا."
        WorkspaceSection.INTEGRATIONS -> "إدارة Webhooks والمنح ليست متاحة من عميل الهاتف بعد."
        else -> "هذه المساحة لم تُوصل بعملية خادمية بعد."
    }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        GlassCard(modifier = Modifier.widthIn(max = 620.dp)) {
            Text("${section.symbol}  ${section.title}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(12.dp))
            Text("غير مفعّل · لم يُنفّذ أي إجراء", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.tertiary)
        }
    }
}

private data class TaskPickerOption(
    val symbol: String,
    val title: String,
    val detail: String,
    val feature: TaskFeature,
    val startsChat: Boolean = false,
    val previewableInMock: Boolean = false,
)

private val chatFeature = TaskFeature(
    key = "chat",
    title = "محادثة نصية",
    capability = "CHAT",
    supportedByClient = true,
)

private val taskPickerOptions = listOf(
    TaskPickerOption("✎", "محادثة نصية", "تُرسل إلى خادم الحساب بعد التحقق من منحة CHAT.", chatFeature, startsChat = true),
    TaskPickerOption(
        "▧", "ملف أو مستند", "رفع الملفات من الهاتف غير موصول.",
        TaskFeature("file", "ملف أو مستند", "FILE_ANALYSIS", "file.read_text", supportedByClient = false, permissionName = "صلاحية تحليل الملفات"),
        previewableInMock = true,
    ),
    TaskPickerOption("◉", "كاميرا أو صورة", "لا يوجد تحليل صور، ولا تُطلب أذونات الكاميرا.", TaskFeature("image", "كاميرا أو صورة", null, supportedByClient = false)),
    TaskPickerOption("✧", "إنشاء صور", "لا يوجد محرك صور موصول.", TaskFeature("image-generation", "إنشاء صور", null, supportedByClient = false)),
    TaskPickerOption("▶", "فيديو · Veo", "غير موصول؛ لا يُرسل شيء إلى Google.", TaskFeature("video", "فيديو · Veo", null, supportedByClient = false)),
    TaskPickerOption("♫", "توليد موسيقى", "لا يوجد محرك موسيقى موصول.", TaskFeature("music", "توليد موسيقى", null, supportedByClient = false)),
    TaskPickerOption("▣", "Canvas ومحرر منقسم", "لا يوجد محرر مباشر موصول.", TaskFeature("canvas", "Canvas ومحرر منقسم", null, supportedByClient = false)),
    TaskPickerOption(
        "⌕", "Deep Research", "الخادم يملك مسار بحث؛ تطبيق الهاتف لا يرسل مهام البحث بعد.",
        TaskFeature("research", "Deep Research", "WEB_RESEARCH", "web.search", supportedByClient = false),
        previewableInMock = true,
    ),
    TaskPickerOption(
        "◇", "تحليل النماذج", "الخادم يعلن أن هذه القدرة غير جاهزة في عينة المحاكاة.",
        TaskFeature("model-analysis", "تحليل النماذج", "MODEL_ANALYSIS", supportedByClient = false),
        previewableInMock = true,
    ),
    TaskPickerOption("◎", "التعلم الموجّه", "غير موصول.", TaskFeature("learning", "التعلم الموجّه", null, supportedByClient = false)),
    TaskPickerOption("✦", "وكيل مخصص", "لا يوجد تدريب/ضبط دقيق موصول.", TaskFeature("agent", "وكيل مخصص", null, supportedByClient = false)),
    TaskPickerOption("🎙", "الصوت المباشر", "لا يوجد نموذج صوت أو إذن ميكروفون مطلوب.", TaskFeature("voice", "الصوت المباشر", null, supportedByClient = false)),
)

@Composable
private fun TaskSelectionSheet(
    state: LazaynovaViewModel.ChatUiState,
    mockMode: Boolean,
    onSelectChat: () -> Unit,
    onStartMockDag: () -> Unit,
    onApproveMockDag: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("اختيار المهمة", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(
            if (mockMode) "بيانات محاكاة واضحة؛ البطاقات تختبر الحالات ولا تنفذ مهامًا غير المحادثة التجريبية."
            else "الحالة من صلاحيات الخادم المصادق عليه. لا تُطلب أذونات الجهاز هنا؛ ستظهر موافقة نظامية فقط عند إضافة إجراء فعلي.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 148.dp),
            modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp),
            contentPadding = PaddingValues(top = 6.dp, bottom = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (mockMode) {
                item(span = { GridItemSpan(maxLineSpan) }, key = "mock-dag-preview") {
                    MockDagPreviewCard(
                        snapshot = state.mockDagSnapshot,
                        isRunning = state.isMockDagRunning,
                        onStart = onStartMockDag,
                        onApprove = onApproveMockDag,
                    )
                }
            }
            gridItems(taskPickerOptions, key = { it.feature.key }) { option ->
                val feature = if (mockMode && option.previewableInMock) option.feature.copy(supportedByClient = true) else option.feature
                val result = evaluateFeatureAvailability(feature, state.capabilitySnapshot)
                TaskActionTile(
                    option = option,
                    result = result,
                    capabilitySnapshot = state.capabilitySnapshot,
                    mockMode = mockMode,
                    onClick = onSelectChat,
                )
            }
        }
    }
}

@Composable
private fun MockDagPreviewCard(
    snapshot: MockDagSnapshot?,
    isRunning: Boolean,
    onStart: () -> Unit,
    onApprove: () -> Unit,
) {
    GlassCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("تدفق DAG تجريبي · محلي", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text("لا ينشئ run خادميًا ولا ينفّذ أداة.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (snapshot == null || snapshot.status == MockDagRunStatus.COMPLETED) {
                TextButton(onClick = onStart, enabled = !isRunning) { Text(if (isRunning) "جارٍ…" else "ابدأ") }
            } else {
                Text(mockDagRunStatusLabel(snapshot.status), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }
        }
        if (snapshot != null) {
            LinearProgressIndicator(progress = { snapshot.progress }, modifier = Modifier.fillMaxWidth())
            snapshot.nodes.forEach { node ->
                MockDagNodeRow(node)
            }
            if (snapshot.status == MockDagRunStatus.WAITING_APPROVAL && !isRunning) {
                Button(onClick = onApprove, modifier = Modifier.fillMaxWidth()) {
                    Text("محاكاة موافقة محلية")
                }
            }
            if (snapshot.approvalIsSimulated) {
                Text(
                    "الموافقة والحالات بيانات عرض اصطناعية، وليست موافقة مالك أو حالة backend.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
        }
    }
}

@Composable
private fun MockDagNodeRow(node: MockDagNodeSnapshot) {
    val availabilityColor = when (node.availability) {
        FeatureAvailability.AVAILABLE -> MaterialTheme.colorScheme.primary
        FeatureAvailability.BUDGET_EXHAUSTED -> MaterialTheme.colorScheme.tertiary
        FeatureAvailability.LACKS_CAPABILITY, FeatureAvailability.BACKEND_UNAVAILABLE -> MaterialTheme.colorScheme.error
        FeatureAvailability.UNSUPPORTED_CLIENT -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(node.title, style = MaterialTheme.typography.bodySmall)
        Column(horizontalAlignment = Alignment.End) {
            Text(mockDagNodeStatusLabel(node.status), style = MaterialTheme.typography.labelSmall)
            Text(node.availability.label, style = MaterialTheme.typography.labelSmall, color = availabilityColor)
        }
    }
}

private fun mockDagRunStatusLabel(status: MockDagRunStatus): String = when (status) {
    MockDagRunStatus.QUEUED -> "في قائمة الانتظار"
    MockDagRunStatus.RUNNING -> "قيد التنفيذ"
    MockDagRunStatus.WAITING_APPROVAL -> "بانتظار موافقة تجريبية"
    MockDagRunStatus.COMPLETED -> "مكتمل · محلي"
}

private fun mockDagNodeStatusLabel(status: MockDagNodeStatus): String = when (status) {
    MockDagNodeStatus.PENDING -> "معلّق"
    MockDagNodeStatus.RUNNING -> "قيد التنفيذ"
    MockDagNodeStatus.WAITING_APPROVAL -> "بانتظار الموافقة"
    MockDagNodeStatus.COMPLETED -> "مكتمل"
    MockDagNodeStatus.BLOCKED -> "محظور"
}

@Composable
private fun TaskActionTile(
    option: TaskPickerOption,
    result: FeatureAvailabilityResult,
    capabilitySnapshot: CapabilitySnapshot?,
    mockMode: Boolean,
    onClick: () -> Unit,
) {
    var showReason by remember(option.feature.key, result.availability) { mutableStateOf(false) }
    val capability = option.feature.capability?.let { capabilitySnapshot?.capability(it) }
    val toolGrant = capability?.toolGrants?.firstOrNull { it.name == option.feature.requiredTool }
    val quota = toolGrant?.usage?.let { ToolQuotaEstimator.estimate(it) }
    val statusColor = when (result.availability) {
        FeatureAvailability.AVAILABLE -> MaterialTheme.colorScheme.primary
        FeatureAvailability.BUDGET_EXHAUSTED -> MaterialTheme.colorScheme.tertiary
        FeatureAvailability.LACKS_CAPABILITY, FeatureAvailability.BACKEND_UNAVAILABLE -> MaterialTheme.colorScheme.error
        FeatureAvailability.UNSUPPORTED_CLIENT -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Card(
        modifier = Modifier.fillMaxWidth().heightIn(min = 142.dp).clickable {
            if (option.startsChat && result.availability == FeatureAvailability.AVAILABLE) onClick() else showReason = true
        },
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (result.availability == FeatureAvailability.AVAILABLE) {
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.62f)
            } else {
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
            },
        ),
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(13.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(option.symbol, fontSize = 19.sp, color = statusColor)
                Spacer(Modifier.weight(1f))
                Text(result.availability.label, style = MaterialTheme.typography.labelSmall, color = statusColor)
            }
            Text(option.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(option.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (capability != null) {
                Text(
                    "منحة ${capability.capability}: ${if (capability.granted) "ممنوحة" else "غير ممنوحة"} · ${if (capability.ready) "الخادم جاهز" else "الخادم غير جاهز"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (toolGrant != null) {
                Text("منحة الأداة ${toolGrant.name}: ${if (toolGrant.granted) "ممنوحة" else "غير ممنوحة"}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (quota != null) {
                Text("تقدير الحصة اليومية: ${quota.dayRemaining} من ${quota.dayLimit} متبقٍ", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    if (showReason) {
        AlertDialog(
            onDismissRequest = { showReason = false },
            title = { Text(option.title) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(result.explanation)
                    option.feature.permissionName?.let { Text("المتطلب: $it، إضافة إلى منحة الخادم. لا يُطلب إذن Android قبل بدء استخدام فعلي.", style = MaterialTheme.typography.bodySmall) }
                    if (toolGrant != null) Text("حالة منحة الأداة: ${if (toolGrant.granted) "ممنوحة" else "غير ممنوحة"}.", style = MaterialTheme.typography.bodySmall)
                    if (quota != null) Text("المتبقي التقديري: ${quota.dayRemaining}/${quota.dayLimit} لليوم UTC و${quota.minuteRemaining}/${quota.minuteLimit} لهذه الدقيقة.", style = MaterialTheme.typography.bodySmall)
                    if (mockMode) Text("هذه لقطة محاكاة محلية؛ لا تمثل حالة حساب حقيقي ولا تنفذ مهمة.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                }
            },
            confirmButton = { TextButton(onClick = { showReason = false }) { Text("حسنًا") } },
        )
    }
}

@Composable
private fun MockModeBanner() {
    Surface(color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.fillMaxWidth()) {
        Text(
            "وضع MOCK · البيانات محلية ومصطنعة — لا تُرسل الرسائل أو بيانات الدخول إلى خادم",
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onTertiaryContainer,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun ThemeChooser(mode: LazaynovaThemeMode, onChange: (LazaynovaThemeMode) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        LazaynovaThemeMode.entries.forEach { item ->
            TextButton(onClick = { onChange(item) }, modifier = Modifier.weight(1f)) {
                Text(if (item == mode) "● ${item.label}" else item.label, maxLines = 1, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun QuickStatusRow(symbol: String, title: String, status: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 9.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(symbol, color = MaterialTheme.colorScheme.primary)
        Column {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MetricRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun GlassCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp), content = content)
    }
}

@Composable
private fun GlowingMark(modifier: Modifier = Modifier.size(76.dp)) {
    val colors = MaterialTheme.colorScheme
    Box(
        modifier = modifier.drawBehindGlow(),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val center = androidx.compose.ui.geometry.Offset(size.width / 2f, size.height / 2f)
            val radius = size.minDimension * 0.38f
            drawCircle(color = colors.primary.copy(alpha = 0.12f), radius = radius * 1.28f, center = center)
            drawCircle(color = colors.secondary.copy(alpha = 0.48f), radius = radius, center = center, style = Stroke(width = size.minDimension * 0.025f))
            drawCircle(color = colors.tertiary.copy(alpha = 0.7f), radius = radius * 0.78f, center = center, style = Stroke(width = size.minDimension * 0.018f))
        }
        Text("✦", fontSize = 31.sp, color = colors.primary)
    }
}

@Composable
private fun Modifier.drawBehindGlow(): Modifier = this.background(
    Brush.radialGradient(
        colors = listOf(MaterialTheme.colorScheme.primary.copy(alpha = 0.26f), MaterialTheme.colorScheme.secondary.copy(alpha = 0.08f), Color.Transparent),
    ),
    shape = CircleShape,
)

@Composable
private fun MessageBubble(message: LazaynovaViewModel.UiChatMessage) {
    val isUser = message.role == "user"
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
        Surface(
            modifier = Modifier.widthIn(max = 720.dp),
            shape = RoundedCornerShape(22.dp),
            color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.9f),
            tonalElevation = 1.dp,
        ) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(if (isUser) "أنت" else "Lazaynova", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                if (message.content.isNotEmpty()) Text(message.content, modifier = Modifier.padding(top = 5.dp), style = MaterialTheme.typography.bodyLarge)
                if (message.isStreaming && message.content.isEmpty()) {
                    Row(modifier = Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(15.dp), strokeWidth = 2.dp)
                        Text("بانتظار بيانات النموذج…", style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (message.isIncomplete) {
                    Text("انقطع الرد قبل تأكيد اكتماله.", modifier = Modifier.padding(top = 6.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun ErrorNotice(message: String, modifier: Modifier = Modifier) {
    Text(text = message, modifier = modifier.fillMaxWidth().padding(top = 8.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun workspaceBrush(): Brush {
    val scheme = MaterialTheme.colorScheme
    return Brush.linearGradient(colors = listOf(scheme.background, scheme.surface, scheme.background))
}

private fun costLabel(microusd: String): String = try {
    BigDecimal(microusd).movePointLeft(6).setScale(6, java.math.RoundingMode.HALF_UP).toPlainString()
} catch (_: NumberFormatException) {
    "—"
}


private val previewActions = object : LazaynovaScreenActions {
    override fun newChat() = Unit
    override fun refreshUsage() = Unit
    override fun refreshCapabilities() = Unit
    override fun startMockDagPreview() = Unit
    override fun approveMockDagPreview() = Unit
    override fun setDraft(value: String) = Unit
    override fun sendMessage() = Unit
    override fun cancelGeneration() = Unit
    override fun signOut() = Unit
}

private fun previewState(): LazaynovaViewModel.ChatUiState {
    val now = Instant.now()
    val minuteReset = now.truncatedTo(java.time.temporal.ChronoUnit.MINUTES).plusSeconds(60)
    val utcReset = now.atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
    fun usage(dayUsed: Int, dayLimit: Int) = ToolUsageSnapshot(
        callsPerMinute = 20,
        usedThisMinute = 4,
        minuteResetAt = minuteReset,
        callsPerDay = dayLimit,
        usedToday = dayUsed,
        utcDayResetAt = utcReset,
        serverTime = now,
        receivedAt = now,
    )
    return LazaynovaViewModel.ChatUiState(
        sessionLoaded = true,
        isAuthenticated = true,
        email = "preview@lazaynova.test",
        provenance = "mock · local-preview",
        usageSummary = LazaynovaApi.UsageSummary("USD", "12", "12", "0", "0", "12", "0", "8420", "3175", "186400"),
        capabilitySnapshot = CapabilitySnapshot(
            listOf(
                CapabilityGrantSnapshot("CHAT", true, true, emptyList()),
                CapabilityGrantSnapshot("WRITING", true, true, emptyList()),
                CapabilityGrantSnapshot("WEB_RESEARCH", true, true, listOf(ToolGrantSnapshot("web.search", true, usage(200, 200)))),
                CapabilityGrantSnapshot("FILE_ANALYSIS", false, true, listOf(ToolGrantSnapshot("file.read_text", false, usage(86, 500)))),
                CapabilityGrantSnapshot("MODEL_ANALYSIS", true, false, emptyList()),
            ),
        ),
        mockDagSnapshot = MockDagSnapshot(
            runId = "preview-only",
            status = MockDagRunStatus.WAITING_APPROVAL,
            progress = 0.55f,
            nodes = listOf(
                MockDagNodeSnapshot("plan", "التخطيط", MockDagNodeStatus.COMPLETED, FeatureAvailability.AVAILABLE),
                MockDagNodeSnapshot("research", "البحث · موافقة تجريبية", MockDagNodeStatus.WAITING_APPROVAL, FeatureAvailability.AVAILABLE),
                MockDagNodeSnapshot("file", "تحليل ملف", MockDagNodeStatus.BLOCKED, FeatureAvailability.UNSUPPORTED_CLIENT),
                MockDagNodeSnapshot("model", "تحليل نموذج", MockDagNodeStatus.BLOCKED, FeatureAvailability.BACKEND_UNAVAILABLE),
            ),
        ),
    )
}

@Composable
private fun PreviewWorkspace(mode: LazaynovaThemeMode, showTasks: Boolean = false) {
    LazaynovaTheme(mode) {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
            ChatScreen(
                state = previewState(),
                actions = previewActions,
                themeMode = mode,
                onThemeModeChange = {},
                mockMode = true,
                initiallyShowTaskSheet = showTasks,
            )
        }
    }
}

@Preview(name = "Phone <600dp · Dark", widthDp = 390, heightDp = 844, showBackground = true)
@Composable
private fun PhoneDarkPreview() = PreviewWorkspace(LazaynovaThemeMode.DARK)

@Preview(name = "Phone <600dp · Light", widthDp = 390, heightDp = 844, showBackground = true)
@Composable
private fun PhoneLightPreview() = PreviewWorkspace(LazaynovaThemeMode.LIGHT)

@Preview(name = "Phone <600dp · Cyberpunk", widthDp = 390, heightDp = 844, showBackground = true)
@Composable
private fun PhoneCyberpunkPreview() = PreviewWorkspace(LazaynovaThemeMode.CYBERPUNK)

@Preview(name = "Tablet 600–1200dp · Dark", widthDp = 800, heightDp = 1024, showBackground = true)
@Composable
private fun TabletDarkPreview() = PreviewWorkspace(LazaynovaThemeMode.DARK)

@Preview(name = "Tablet 600–1200dp · Light", widthDp = 800, heightDp = 1024, showBackground = true)
@Composable
private fun TabletLightPreview() = PreviewWorkspace(LazaynovaThemeMode.LIGHT)

@Preview(name = "Tablet 600–1200dp · Cyberpunk", widthDp = 800, heightDp = 1024, showBackground = true)
@Composable
private fun TabletCyberpunkPreview() = PreviewWorkspace(LazaynovaThemeMode.CYBERPUNK)

@Preview(name = "Wide >1200dp · Dark", widthDp = 1440, heightDp = 1000, showBackground = true)
@Composable
private fun WideDarkPreview() = PreviewWorkspace(LazaynovaThemeMode.DARK)

@Preview(name = "Wide >1200dp · Light", widthDp = 1440, heightDp = 1000, showBackground = true)
@Composable
private fun WideLightPreview() = PreviewWorkspace(LazaynovaThemeMode.LIGHT)

@Preview(name = "Wide >1200dp · Cyberpunk", widthDp = 1440, heightDp = 1000, showBackground = true)
@Composable
private fun WideCyberpunkPreview() = PreviewWorkspace(LazaynovaThemeMode.CYBERPUNK)

@Preview(name = "Mock task statuses · Cyberpunk", widthDp = 720, heightDp = 920, showBackground = true)
@Composable
private fun MockTaskStatusesPreview() = PreviewWorkspace(LazaynovaThemeMode.CYBERPUNK, showTasks = true)
