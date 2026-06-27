package com.dropbeam.app.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dropbeam.app.data.AuthRepository
import com.dropbeam.app.network.DropBeamApi
import com.dropbeam.app.network.FileTransferManager
import com.dropbeam.app.network.TailscaleManager
import com.dropbeam.app.ui.theme.*
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    authRepo: AuthRepository,
    api: DropBeamApi,
    tsManager: TailscaleManager,
    transferManager: FileTransferManager,
    sharedFiles: List<Uri>,
    onClearSharedFiles: () -> Unit,
    onSignOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val status by tsManager.status.collectAsState()
    val peers by tsManager.peers.collectAsState()
    val activeTransfer by transferManager.activeTransfer.collectAsState()
    val userName by authRepo.userName.collectAsState(initial = null)

    var selectedFiles by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var showDevicePicker by remember { mutableStateOf(false) }
    var connectError by remember { mutableStateOf<String?>(null) }

    // Handle files shared from other apps
    LaunchedEffect(sharedFiles) {
        if (sharedFiles.isNotEmpty()) {
            selectedFiles = sharedFiles
            onClearSharedFiles()
            if (peers.size == 1) {
                transferManager.sendFiles(sharedFiles, peers.first())
            } else if (peers.isNotEmpty()) {
                showDevicePicker = true
            }
        }
    }

    // Auto-connect on launch
    LaunchedEffect(Unit) {
        if (status.state == TailscaleManager.ConnectionState.DISCONNECTED) {
            val regResult = api.registerDevice()
            regResult.fold(
                onSuccess = { reg ->
                    val deviceName = android.os.Build.MODEL.replace(" ", "-")
                    tsManager.start(reg.headscaleUrl, reg.preAuthKey, deviceName)
                },
                onFailure = { e ->
                    connectError = e.message
                },
            )
        }
    }

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris.isNotEmpty()) {
            selectedFiles = uris
            if (peers.size == 1) {
                scope.launch {
                    transferManager.sendFiles(uris, peers.first())
                    selectedFiles = emptyList()
                }
            } else if (peers.isNotEmpty()) {
                showDevicePicker = true
            }
        }
    }

    Scaffold(
        containerColor = Bg,
        topBar = {
            TopBar(
                userName = userName,
                status = status,
                onSignOut = {
                    scope.launch {
                        tsManager.stop()
                        authRepo.clear()
                        onSignOut()
                    }
                },
            )
        },
        bottomBar = {
            BottomSendBar(
                selectedFiles = selectedFiles,
                hasDevices = peers.isNotEmpty(),
                activeTransfer = activeTransfer,
                onChooseFiles = { filePicker.launch(arrayOf("*/*")) },
                onSendFiles = {
                    if (peers.size == 1) {
                        scope.launch {
                            transferManager.sendFiles(selectedFiles, peers.first())
                            selectedFiles = emptyList()
                        }
                    } else {
                        showDevicePicker = true
                    }
                },
                onClearFiles = { selectedFiles = emptyList() },
                onClearTransfer = { transferManager.clearTransfer() },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // Connection status / scan bar
            ScanBar(status = status, peerCount = peers.size)

            // Error banner
            connectError?.let { err ->
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    shape = RoundedCornerShape(12.dp),
                    color = Danger.copy(alpha = 0.1f),
                    border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                        brush = Brush.linearGradient(listOf(Danger.copy(alpha = 0.3f), Danger.copy(alpha = 0.3f)))
                    ),
                ) {
                    Text(
                        text = err,
                        color = Danger,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(14.dp),
                    )
                }
            }

            // Device list
            if (peers.isEmpty()) {
                EmptyState(isConnecting = status.state == TailscaleManager.ConnectionState.CONNECTING)
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(peers, key = { it.ip }) { peer ->
                        DeviceCard(
                            peer = peer,
                            activeTransfer = activeTransfer,
                            onClick = {
                                if (selectedFiles.isNotEmpty()) {
                                    scope.launch {
                                        transferManager.sendFiles(selectedFiles, peer)
                                        selectedFiles = emptyList()
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    // Device picker bottom sheet
    if (showDevicePicker) {
        DevicePickerSheet(
            peers = peers,
            fileCount = selectedFiles.size,
            onDeviceSelected = { peer ->
                showDevicePicker = false
                scope.launch {
                    transferManager.sendFiles(selectedFiles, peer)
                    selectedFiles = emptyList()
                }
            },
            onDismiss = { showDevicePicker = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TopBar(
    userName: String?,
    status: TailscaleManager.Status,
    onSignOut: () -> Unit,
) {
    CenterAlignedTopAppBar(
        colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
            containerColor = Bg.copy(alpha = 0.94f),
        ),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "DROPBEAM",
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 15.sp,
                    letterSpacing = 2.sp,
                    color = Accent,
                )
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(Accent),
                )
            }
        },
        navigationIcon = {
            if (userName != null) {
                Box(
                    modifier = Modifier
                        .padding(start = 12.dp)
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(AccentDim)
                        .border(1.dp, Accent.copy(alpha = 0.3f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = userName.first().uppercase(),
                        color = Accent,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }
        },
        actions = {
            // Connection pill
            val pillColor = when (status.state) {
                TailscaleManager.ConnectionState.CONNECTED -> Accent
                TailscaleManager.ConnectionState.CONNECTING -> Warn
                else -> Danger
            }
            val pillText = when (status.state) {
                TailscaleManager.ConnectionState.CONNECTED -> "MESH"
                TailscaleManager.ConnectionState.CONNECTING -> "JOINING"
                TailscaleManager.ConnectionState.ERROR -> "ERROR"
                else -> "OFFLINE"
            }
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = pillColor.copy(alpha = 0.12f),
                border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                    brush = Brush.linearGradient(listOf(pillColor.copy(alpha = 0.25f), pillColor.copy(alpha = 0.25f)))
                ),
                modifier = Modifier.padding(end = 12.dp),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(pillColor),
                    )
                    Text(
                        text = pillText,
                        color = pillColor,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.8.sp,
                    )
                }
            }

            IconButton(onClick = onSignOut) {
                Icon(
                    Icons.Outlined.Logout,
                    contentDescription = "Sign out",
                    tint = TextDim,
                    modifier = Modifier.size(20.dp),
                )
            }
        },
    )
}

@Composable
private fun ScanBar(status: TailscaleManager.Status, peerCount: Int) {
    val isScanning = status.state == TailscaleManager.ConnectionState.CONNECTING ||
            (status.state == TailscaleManager.ConnectionState.CONNECTED && peerCount == 0)

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (isScanning) Accent.copy(alpha = 0.03f) else Color.Transparent,
        border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
            brush = Brush.linearGradient(listOf(Border, Border))
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (isScanning) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    color = Accent,
                    strokeWidth = 2.5.dp,
                )
            }
            Text(
                text = when {
                    status.state == TailscaleManager.ConnectionState.CONNECTING -> "Joining mesh network..."
                    peerCount == 0 -> "Scanning for devices..."
                    peerCount == 1 -> "1 device found"
                    else -> "$peerCount devices found"
                },
                color = TextSecondary,
                fontSize = 14.sp,
                modifier = Modifier.weight(1f),
            )
            if (peerCount > 0) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = AccentDim,
                    border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                        brush = Brush.linearGradient(listOf(Accent.copy(alpha = 0.25f), Accent.copy(alpha = 0.25f)))
                    ),
                ) {
                    Text(
                        text = "$peerCount found",
                        color = Accent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyState(isConnecting: Boolean) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                if (isConnecting) Icons.Outlined.Radar else Icons.Outlined.DevicesOther,
                contentDescription = null,
                modifier = Modifier.size(56.dp),
                tint = TextDim,
            )
            Spacer(Modifier.height(20.dp))
            Text(
                text = if (isConnecting) "Joining mesh network..." else "No devices found yet",
                style = MaterialTheme.typography.titleMedium,
                color = TextMuted,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Make sure other devices are running\nDropBeam and connected to the mesh",
                style = MaterialTheme.typography.bodyMedium,
                color = TextDim,
                lineHeight = 22.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun DeviceCard(
    peer: TailscaleManager.MeshPeer,
    activeTransfer: FileTransferManager.TransferProgress?,
    onClick: () -> Unit,
) {
    val isTransferring = activeTransfer != null &&
            activeTransfer.peerName == peer.name &&
            !activeTransfer.done

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = Color.Transparent,
        border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
            brush = Brush.linearGradient(
                if (isTransferring) listOf(Accent2.copy(alpha = 0.4f), Accent2.copy(alpha = 0.4f))
                else listOf(Border2, Border2)
            )
        ),
    ) {
        Box(
            modifier = Modifier.background(
                Brush.linearGradient(
                    listOf(Color.White.copy(alpha = 0.05f), Color.White.copy(alpha = 0.02f))
                )
            ),
        ) {
            Column {
                Row(
                    modifier = Modifier
                        .padding(16.dp)
                        .fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Device icon
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .background(
                                Brush.linearGradient(
                                    listOf(Accent2.copy(alpha = 0.1f), Accent2.copy(alpha = 0.03f))
                                )
                            )
                            .border(1.dp, Accent2.copy(alpha = 0.3f), RoundedCornerShape(14.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            when {
                                peer.os.contains("android", ignoreCase = true) -> Icons.Filled.PhoneAndroid
                                peer.os.contains("ios", ignoreCase = true) -> Icons.Filled.PhoneIphone
                                else -> Icons.Filled.Computer
                            },
                            contentDescription = null,
                            tint = Accent2.copy(alpha = 0.7f),
                            modifier = Modifier.size(24.dp),
                        )
                    }

                    Spacer(Modifier.width(16.dp))

                    Column(modifier = Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(if (peer.online) Accent else TextDim),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = peer.name,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Surface(
                                shape = RoundedCornerShape(6.dp),
                                color = Accent2.copy(alpha = 0.12f),
                                border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                                    brush = Brush.linearGradient(listOf(Accent2.copy(alpha = 0.25f), Accent2.copy(alpha = 0.25f)))
                                ),
                            ) {
                                Text(
                                    text = "MESH",
                                    color = Accent2,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 0.6.sp,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                )
                            }
                            Text(
                                text = peer.ip,
                                color = TextDim,
                                fontSize = 12.sp,
                            )
                        }

                        // Transfer status
                        if (isTransferring) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                text = "Sending ${activeTransfer!!.fileName} · ${activeTransfer.percent}%",
                                color = Accent2,
                                fontSize = 12.sp,
                            )
                        }
                        if (activeTransfer?.peerName == peer.name && activeTransfer?.done == true) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                text = if (activeTransfer.error != null) "Failed: ${activeTransfer.error}" else "Sent successfully",
                                color = if (activeTransfer.error != null) Danger else Success,
                                fontSize = 12.sp,
                            )
                        }
                    }

                    Icon(
                        Icons.Filled.ChevronRight,
                        contentDescription = null,
                        tint = TextDim,
                        modifier = Modifier.size(22.dp),
                    )
                }

                // Progress bar
                if (isTransferring) {
                    LinearProgressIndicator(
                        progress = { activeTransfer!!.percent / 100f },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(3.dp),
                        color = Accent2,
                        trackColor = Color.White.copy(alpha = 0.04f),
                    )
                }
            }
        }
    }
}

@Composable
private fun BottomSendBar(
    selectedFiles: List<Uri>,
    hasDevices: Boolean,
    activeTransfer: FileTransferManager.TransferProgress?,
    onChooseFiles: () -> Unit,
    onSendFiles: () -> Unit,
    onClearFiles: () -> Unit,
    onClearTransfer: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Bg.copy(alpha = 0.96f),
        border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
            brush = Brush.linearGradient(listOf(Border2, Border2))
        ),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 14.dp)
                .navigationBarsPadding(),
        ) {
            // Active transfer indicator
            activeTransfer?.let { transfer ->
                if (!transfer.done) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(bottom = 12.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = Accent2,
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = "Sending ${transfer.fileName} to ${transfer.peerName}",
                            color = Accent2,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = "${transfer.percent}%",
                            color = Accent2,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    LinearProgressIndicator(
                        progress = { transfer.percent / 100f },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(3.dp)
                            .padding(bottom = 12.dp),
                        color = Accent2,
                        trackColor = Color.White.copy(alpha = 0.04f),
                    )
                }
                if (transfer.done) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(bottom = 12.dp),
                    ) {
                        Icon(
                            if (transfer.error != null) Icons.Filled.ErrorOutline else Icons.Filled.CheckCircleOutline,
                            contentDescription = null,
                            tint = if (transfer.error != null) Danger else Success,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = if (transfer.error != null) "Transfer failed" else "Sent ${transfer.fileName}",
                            color = if (transfer.error != null) Danger else Success,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = onClearTransfer) {
                            Text("Dismiss", color = TextMuted, fontSize = 12.sp)
                        }
                    }
                }
            }

            if (selectedFiles.isEmpty()) {
                // Choose files button
                Button(
                    onClick = onChooseFiles,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(60.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Accent,
                        contentColor = Color.Black,
                    ),
                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 4.dp),
                ) {
                    Icon(Icons.Filled.AttachFile, contentDescription = null, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text("Choose Files to Send", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                }
            } else {
                // Selected files + send button
                Row(
                    modifier = Modifier.padding(bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "${selectedFiles.size} file${if (selectedFiles.size != 1) "s" else ""} selected",
                        color = TextMuted,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.8.sp,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onClearFiles) {
                        Icon(Icons.Filled.Close, contentDescription = null, tint = TextDim, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Clear", color = TextDim, fontSize = 13.sp)
                    }
                }
                Button(
                    onClick = onSendFiles,
                    enabled = hasDevices,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(60.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Accent,
                        contentColor = Color.Black,
                        disabledContainerColor = Accent.copy(alpha = 0.3f),
                        disabledContentColor = Color.Black.copy(alpha = 0.5f),
                    ),
                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 4.dp),
                ) {
                    Icon(Icons.Filled.Send, contentDescription = null, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text("Send Files", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DevicePickerSheet(
    peers: List<TailscaleManager.MeshPeer>,
    fileCount: Int,
    onDeviceSelected: (TailscaleManager.MeshPeer) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = BgElevated,
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 12.dp, bottom = 8.dp)
                    .width(36.dp)
                    .height(4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(Border2),
            )
        },
    ) {
        Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            Text(
                text = "Send to which device?",
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 20.sp),
                modifier = Modifier.padding(bottom = 4.dp),
            )
            Text(
                text = "$fileCount file${if (fileCount != 1) "s" else ""} selected — tap a device to send",
                color = TextMuted,
                fontSize = 14.sp,
                modifier = Modifier.padding(bottom = 20.dp),
            )

            peers.forEach { peer ->
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 10.dp)
                        .clickable { onDeviceSelected(peer) },
                    shape = RoundedCornerShape(16.dp),
                    color = Color.Transparent,
                    border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                        brush = Brush.linearGradient(listOf(Border2, Border2))
                    ),
                ) {
                    Row(
                        modifier = Modifier
                            .background(
                                Brush.linearGradient(
                                    listOf(Color.White.copy(alpha = 0.06f), Color.White.copy(alpha = 0.02f))
                                )
                            )
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(Accent2.copy(alpha = 0.08f))
                                .border(1.dp, Accent2.copy(alpha = 0.25f), RoundedCornerShape(12.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                when {
                                    peer.os.contains("android", ignoreCase = true) -> Icons.Filled.PhoneAndroid
                                    else -> Icons.Filled.Computer
                                },
                                contentDescription = null,
                                tint = Accent2.copy(alpha = 0.7f),
                                modifier = Modifier.size(22.dp),
                            )
                        }
                        Spacer(Modifier.width(16.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(peer.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                            Text(peer.ip, color = TextMuted, fontSize = 13.sp)
                        }
                        Icon(
                            Icons.Filled.ChevronRight,
                            contentDescription = null,
                            tint = TextDim,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            Button(
                onClick = onDismiss,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = SurfaceVariant,
                    contentColor = TextMuted,
                ),
            ) {
                Text("Cancel", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
