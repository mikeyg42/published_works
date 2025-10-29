// Simple Backend #2 - WebSocket animation frame streaming on port 3030
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use warp::Filter;
use warp::ws::{WebSocket, Message};
use futures_util::{SinkExt, StreamExt};
use image::{ImageBuffer, ImageFormat};

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionStreamRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PingPong {
    pub r#type: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    // Health check endpoint
    let health = warp::path("health")
        .and(warp::get())
        .map(|| {
            log::info!("Health check requested");
            warp::reply::json(&serde_json::json!({
                "status": "healthy",
                "service": "Backend #2 - GPU Animation Renderer",
                "port": 3030
            }))
        });

    // Animation WebSocket endpoint - matches frontend expectation
    let animation_ws = warp::path("stream")
        .and(warp::ws())
        .map(|ws: warp::ws::Ws| {
            log::info!("WebSocket upgrade requested");
            ws.on_upgrade(move |websocket| handle_animation_stream(websocket))
        });

    // Combine all routes with CORS
    let routes = health
        .or(animation_ws)
        .with(warp::cors()
            .allow_any_origin()
            .allow_headers(vec!["content-type"])
            .allow_methods(vec!["GET", "POST"]));

    let port = 3030u16;
    log::info!("🚀 Starting Backend #2 (GPU Animation Renderer) on port {}", port);

    warp::serve(routes)
        .run(([0, 0, 0, 0], port))
        .await;

    Ok(())
}

async fn handle_animation_stream(ws: WebSocket) {
    log::info!("✅ New animation WebSocket connection established");

    let (mut ws_sender, mut ws_receiver) = ws.split();
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<String>();
    let last_ping = Arc::new(Mutex::new(std::time::Instant::now()));
    let last_ping_clone = last_ping.clone();
    let mut pending_frame: Option<Vec<u8>> = None;

    // Spawn frame sender task with backpressure handling
    let sender_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                // New frame available from generator
                Some(frame) = frame_rx.recv() => {
                    // Backpressure: replace pending frame if client is behind
                    pending_frame = Some(frame);
                }

                // Send pending frame to client (30 FPS = ~33ms)
                _ = tokio::time::sleep(Duration::from_millis(33)), if pending_frame.is_some() => {
                    if let Some(frame) = pending_frame.take() {
                        if ws_sender.send(Message::binary(frame)).await.is_err() {
                            log::info!("Client disconnected during frame send");
                            break; // Connection closed
                        }
                    }
                }

                // Send text messages from main loop
                Some(text_msg) = msg_rx.recv() => {
                    if ws_sender.send(Message::text(text_msg)).await.is_err() {
                        log::info!("Client disconnected during text send");
                        break;
                    }
                }

                // Health check: ping timeout detection
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    if let Ok(last_ping_time) = last_ping_clone.lock() {
                        if last_ping_time.elapsed() > Duration::from_secs(30) {
                            log::warn!("❌ Animation stream ping timeout - client may be disconnected");
                            break; // Client disconnected
                        }
                    }
                }
            }
        }
        log::info!("Frame sender task ended");
    });

    // Handle incoming WebSocket messages
    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(msg) if msg.is_text() => {
                let text = msg.to_str().unwrap_or("");
                log::debug!("Received text message: {}", text);

                // Handle ping/pong for connection health
                log::debug!("Attempting to parse ping/pong from: {}", text);
                if let Ok(ping_pong) = serde_json::from_str::<PingPong>(&text) {
                    log::debug!("Successfully parsed ping/pong: {:?}", ping_pong);
                    if ping_pong.r#type == "ping" {
                        log::info!("🏓 Received ping, sending pong");
                        if let Ok(mut last_ping_time) = last_ping.lock() {
                            *last_ping_time = std::time::Instant::now();
                        }
                        let pong = PingPong { r#type: "pong".to_string() };
                        if let Ok(pong_json) = serde_json::to_string(&pong) {
                            log::debug!("Sending pong JSON: {}", pong_json);
                            if msg_tx.send(pong_json).is_err() {
                                log::error!("Failed to send pong message");
                                break;
                            }
                            log::info!("✅ Pong sent successfully");
                        }
                        continue;
                    }
                } else {
                    log::debug!("Failed to parse as ping/pong");
                }

                // Handle session-based animation request
                if let Ok(session_request) = serde_json::from_str::<SessionStreamRequest>(&text) {
                    log::info!("🎬 Starting animation stream for session: {}", session_request.session_id);

                    // Generate animation frames in background
                    let frame_tx_clone = frame_tx.clone();
                    let session_id = session_request.session_id.clone();
                    tokio::spawn(async move {
                        if let Err(e) = generate_animation_frames(session_id, frame_tx_clone).await {
                            log::error!("❌ Animation generation failed: {}", e);
                        }
                    });
                } else {
                    log::warn!("⚠️ Received unknown text message: {}", text);
                }
            }
            Ok(msg) if msg.is_close() => {
                log::info!("🔌 Animation WebSocket closed by client");
                break;
            }
            Err(e) => {
                log::error!("❌ Animation WebSocket error: {}", e);
                break;
            }
            _ => {
                log::debug!("Received non-text message, ignoring");
            }
        }
    }

    // Cleanup
    sender_handle.abort();
    log::info!("🔚 Animation WebSocket connection ended");
}

// Generate mock animation frames for testing dual WebSocket flow
async fn generate_animation_frames(
    session_id: String,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
) -> Result<()> {
    log::info!("🎨 Generating animation frames for session: {}", session_id);

    // Generate 60 frames at 30fps (2 second animation loop)
    let total_frames = 60;
    let frame_duration = Duration::from_millis(33); // 30 FPS

    for frame_num in 0..total_frames {
        // Create animated gradient pattern
        let width = 800;
        let height = 600;

        let mut img_buffer = ImageBuffer::new(width, height);
        for y in 0..height {
            for x in 0..width {
                // Create animated wave pattern
                let time = frame_num as f32 * 0.1;
                let wave_x = ((x as f32 / 50.0 + time).sin() + 1.0) * 127.0;
                let wave_y = ((y as f32 / 50.0 + time * 0.7).sin() + 1.0) * 127.0;

                let r = (wave_x) as u8;
                let g = (wave_y) as u8;
                let b = ((frame_num * 4) % 256) as u8;

                img_buffer.put_pixel(x, y, image::Rgba([r, g, b, 255]));
            }
        }

        // Encode as PNG
        let mut png_data = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut png_data);
            img_buffer.write_to(&mut cursor, ImageFormat::Png)
                .map_err(|e| anyhow::anyhow!("PNG encoding error: {}", e))?;
        }

        // Send frame via channel (backpressure handled by receiver)
        if frame_tx.send(png_data).is_err() {
            log::info!("🔌 Animation stopped - client disconnected");
            break;
        }

        // Control frame rate
        tokio::time::sleep(frame_duration).await;
    }

    log::info!("✅ Animation complete for session: {}", session_id);
    Ok(())
}