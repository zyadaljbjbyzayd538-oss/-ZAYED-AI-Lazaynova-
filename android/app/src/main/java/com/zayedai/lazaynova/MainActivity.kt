package com.zayedai.lazaynova

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zayedai.lazaynova.ui.ChatScreen
import com.zayedai.lazaynova.ui.LazaynovaViewModel
import com.zayedai.lazaynova.ui.LoadingScreen
import com.zayedai.lazaynova.ui.LoginScreen

class MainActivity : ComponentActivity() {
    private val viewModel: LazaynovaViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                MaterialTheme {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        when {
                            !state.sessionLoaded -> LoadingScreen()
                            state.isAuthenticated -> ChatScreen(state, viewModel)
                            else -> LoginScreen(state, viewModel)
                        }
                    }
                }
            }
        }
    }
}
