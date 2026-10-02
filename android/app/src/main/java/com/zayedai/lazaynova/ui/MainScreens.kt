package com.zayedai.lazaynova.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Lazaynova", fontSize = 34.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Text("ZAYED AI · خاص وآمن", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(10.dp))
        Text(
            "سجّل الدخول إلى خادم Lazaynova الخاص بك. يختار الخادم مزود ونموذج المحادثة؛ لا يحتوي التطبيق على مفاتيح مزودين.",
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(28.dp))

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
        OutlinedTextField(
            value = state.email,
            onValueChange = viewModel::setEmail,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("البريد الإلكتروني") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            enabled = !state.isLoading,
        )
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
        state.error?.let { ErrorNotice(it) }
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = viewModel::login,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.isLoading && state.baseUrl.isNotBlank() && state.email.isNotBlank() && state.password.isNotBlank(),
        ) {
            if (state.isLoading) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text("تسجيل الدخول")
        }
        Spacer(Modifier.height(20.dp))
        Text(
            "لا تُحفظ كلمة المرور. يُشفّر رمز الجلسة محليًا بمفتاح Android Keystore، ويُرسل عبر HTTPS فقط.",
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(state: LazaynovaViewModel.ChatUiState, viewModel: LazaynovaViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Lazaynova", fontWeight = FontWeight.SemiBold)
                        Text("جلسة موثّقة · اختيار النموذج من الخادم", style = MaterialTheme.typography.labelSmall)
                    }
                },
                actions = {
                    TextButton(onClick = viewModel::signOut, enabled = !state.isSigningOut) {
                        Text(if (state.isSigningOut) "جارٍ الخروج…" else "خروج")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (state.messages.isEmpty()) {
                Column(
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(28.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("أهلًا بك في Lazaynova", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "اكتب طلبك لبدء محادثة. سيظهر الرد تدريجيًا عند وصول دلتا حقيقية من مزود النموذج المضبوط على الخادم.",
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("لا يختار التطبيق النموذج ولا يدّعي تنفيذ تحكم بالهاتف.", textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(state.messages, key = { it.id }) { message -> MessageBubble(message) }
                }
            }

            state.provenance?.let {
                Text(it, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp), style = MaterialTheme.typography.labelSmall)
            }
            state.error?.let { ErrorNotice(it, Modifier.padding(horizontal = 16.dp)) }

            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = state.draft,
                    onValueChange = viewModel::setDraft,
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("اكتب رسالتك…") },
                    minLines = 1,
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { viewModel.sendMessage() }),
                    enabled = !state.isSending,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (state.isSending) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        TextButton(onClick = viewModel::cancelGeneration) { Text("إيقاف التدفق") }
                    } else {
                        Text("${state.draft.length}/20000", style = MaterialTheme.typography.labelSmall)
                        Button(onClick = viewModel::sendMessage, enabled = state.draft.isNotBlank()) { Text("إرسال") }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: LazaynovaViewModel.UiChatMessage) {
    val isUser = message.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            modifier = Modifier.widthIn(max = 560.dp),
            shape = MaterialTheme.shapes.large,
            color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(if (isUser) "أنت" else "Lazaynova", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                if (message.content.isNotEmpty()) {
                    Text(message.content, modifier = Modifier.padding(top = 5.dp), style = MaterialTheme.typography.bodyLarge)
                }
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
    Text(
        text = message,
        modifier = modifier.fillMaxWidth().padding(top = 8.dp),
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodySmall,
    )
}
