package com.zayedai.lazaynova

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zayedai.lazaynova.ui.ChatScreen
import com.zayedai.lazaynova.ui.LazaynovaTheme
import com.zayedai.lazaynova.ui.LazaynovaThemeMode
import com.zayedai.lazaynova.ui.LazaynovaViewModel
import com.zayedai.lazaynova.ui.LoadingScreen
import com.zayedai.lazaynova.ui.LoginScreen

class MainActivity : ComponentActivity() {
    private val viewModel: LazaynovaViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            var themeMode by rememberSaveable { mutableStateOf(LazaynovaThemeMode.CYBERPUNK) }
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                LazaynovaTheme(themeMode) {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        when {
                            !state.sessionLoaded -> LoadingScreen()
                            state.isAuthenticated -> ChatScreen(state, viewModel, themeMode, { themeMode = it })
                            else -> LoginScreen(state, viewModel)
                        }
                    }
                }
            }
        }
    }
}
