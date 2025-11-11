// gpu_renderer/src/http_server.rs
use crate::{PathTracer, Args, MazeData};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time::timeout;
use warp::{Filter, Rejection, Reply};
use warp::http::{Response, StatusCode};
use warp::ws::{WebSocket, Message};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use base64::{Engine as _, engine::general_purpose};
use image::{ImageBuffer, Rgba, ImageFormat, DynamicImage};

// ============= Request/Response Models =============

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderRequest {
    pub maze_data: MazeData,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub samples: Option<u32>,
    pub session_id: Option<String>,  // Added to match Service #1
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderResponse {
    pub task_id: String,
    pub session_id: String,
    pub status: String,
    pub message: String,
    pub status_url: String,
    pub stream_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatusResponse {
    pub task_id: String,
    pub session_id: String,
    pub status: String,
    pub progress: Option<f32>,
    pub image_url: Option<String>,
    pub stream_url: Option<String>,
    pub error: Option<String>,
}

// New models for animation streaming
#[derive(Debug, Serialize, Deserialize)]
pub struct AnimationStreamRequest {
    pub maze_data: MazeData,
    pub solution_data: serde_json::Value, // Flexible solution format
    pub animation_config: AnimationConfig,
}

// Simple session-based request (matches frontend)
#[derive(Debug, Serialize, Deserialize)]
pub struct SessionStreamRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnimationConfig {
    pub fps: u32,
    pub quality: String, // "low", "medium", "high"
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PingPong {
    pub r#type: String, // "ping" or "pong"
}

#[derive(Debug, Clone)]
pub struct TaskStatus {
    pub session_id: String,
    pub status: String,
    pub progress: f32,
    pub image_data: Option<Vec<u8>>,
    pub error: Option<String>,
    pub created_at: std::time::Instant,
}

// ============= Custom Error Handling =============

#[derive(Debug)]
struct ServiceError {
    message: String,
    status_code: StatusCode,
}

impl warp::reject::Reject for ServiceError {}

async fn handle_rejection(err: Rejection) -> Result<impl Reply, std::convert::Infallible> {
    let code;
    let message;

    if err.is_not_found() {
        code = StatusCode::NOT_FOUND;
        message = "Not Found";
    } else if let Some(service_err) = err.find::<ServiceError>() {
        code = service_err.status_code;
        message = &service_err.message;
    } else if err.find::<warp::reject::MethodNotAllowed>().is_some() {
        code = StatusCode::METHOD_NOT_ALLOWED;
        message = "Method Not Allowed";
    } else if err.find::<warp::reject::PayloadTooLarge>().is_some() {
        code = StatusCode::PAYLOAD_TOO_LARGE;
        message = "Payload too large";
    } else {
        log::error!("unhandled rejection: {:?}", err);
        code = StatusCode::INTERNAL_SERVER_ERROR;
        message = "Internal Server Error";
    }

    let json = warp::reply::json(&serde_json::json!({
        "error": message,
        "status_code": code.as_u16(),
    }));

    Ok(warp::reply::with_status(json, code))
}

// ============= Shared State =============

type TaskStore = Arc<RwLock<HashMap<String, TaskStatus>>>;

#[derive(Clone)]
pub struct ServerState {
    tasks: TaskStore,
    max_concurrent_renders: usize,
    render_semaphore: Arc<tokio::sync::Semaphore>,
}

impl ServerState {
    fn new() -> Self {
        let max_concurrent = std::env::var("MAX_CONCURRENT_RENDERS")
            .unwrap_or_else(|_| "4".to_string())
            .parse()
            .unwrap_or(4);

        Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            max_concurrent_renders: max_concurrent,
            render_semaphore: Arc::new(tokio::sync::Semaphore::new(max_concurrent)),
        }
    }

    async fn cleanup_old_tasks(&self) {
        let mut tasks = self.tasks.write().await;
        let now = std::time::Instant::now();
        let expiry = Duration::from_secs(3600); // 1 hour

        tasks.retain(|_, task| {
            now.duration_since(task.created_at) < expiry
        });
    }
}

// ============= Animation Streaming =============

// Message types for WebSocket sender channel
enum WsMessage {
    Binary(Vec<u8>),
    Text(String),
}

async fn handle_animation_stream(ws: WebSocket, state: ServerState) {
    log::info!("New animation WebSocket connection");

    let (mut ws_sender, mut ws_receiver) = ws.split();
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<WsMessage>();
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mut last_ping = std::time::Instant::now();
    let mut pending_frame: Option<Vec<u8>> = None;

    // Spawn WebSocket sender task (handles both frames and control messages)
    let sender_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                // New frame available
                Some(frame) = frame_rx.recv() => {
                    // Backpressure: replace pending frame if client is behind
                    pending_frame = Some(frame);
                }

                // Control message (pong, etc.)
                Some(ws_msg) = msg_rx.recv() => {
                    let result = match ws_msg {
                        WsMessage::Binary(data) => ws_sender.send(Message::binary(data)).await,
                        WsMessage::Text(text) => ws_sender.send(Message::text(text)).await,
                    };
                    if result.is_err() {
                        break; // Connection closed
                    }
                }

                // Send pending frame to client
                _ = tokio::time::sleep(Duration::from_millis(33)), if pending_frame.is_some() => {
                    if let Some(frame) = pending_frame.take() {
                        if ws_sender.send(Message::binary(frame)).await.is_err() {
                            break; // Connection closed
                        }
                    }
                }

                // Check for ping timeout (30s = 2 missed pings)
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    if last_ping.elapsed() > Duration::from_secs(30) {
                        log::warn!("Animation stream ping timeout");
                        break; // Client disconnected
                    }
                }
            }
        }
    });

    // Handle incoming messages (ping/pong and animation requests)
    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(msg) if msg.is_text() => {
                let text = msg.to_str().unwrap_or("");
                if let Ok(ping_pong) = serde_json::from_str::<PingPong>(text) {
                    if ping_pong.r#type == "ping" {
                        last_ping = std::time::Instant::now();
                        let pong = PingPong { r#type: "pong".to_string() };
                        if let Ok(pong_json) = serde_json::to_string(&pong) {
                            if msg_tx.send(WsMessage::Text(pong_json)).is_err() {
                                break;
                            }
                        }
                    }
                }

                // Try to parse as simple session request (frontend format)
                if let Ok(session_request) = serde_json::from_str::<SessionStreamRequest>(text) {
                    log::info!("Starting animation stream for session: {}", session_request.session_id);

                    // For now, generate mock animation frames for the session
                    // TODO: In production, fetch maze data from Backend #1 using session_id
                    let frame_tx_clone = frame_tx.clone();
                    let state_clone = state.clone();
                    let session_id = session_request.session_id.clone();
                    tokio::spawn(async move {
                        if let Err(e) = generate_mock_animation_frames(session_id, frame_tx_clone, state_clone).await {
                            log::error!("Mock animation generation failed: {}", e);
                        }
                    });
                }

                // Try to parse as full animation request (for direct API calls)
                else if let Ok(request) = serde_json::from_str::<AnimationStreamRequest>(text) {
                    log::info!("Starting animation stream for direct maze data");

                    // Start animation generation in background task
                    let frame_tx_clone = frame_tx.clone();
                    let state_clone = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = generate_animation_frames(request, frame_tx_clone, state_clone).await {
                            log::error!("Animation generation failed: {}", e);
                        }
                    });
                }
            }
            Ok(msg) if msg.is_close() => {
                log::info!("Animation WebSocket closed by client");
                break;
            }
            Err(e) => {
                log::error!("Animation WebSocket error: {}", e);
                break;
            }
            _ => {} // Ignore other message types
        }
    }

    // Cleanup
    sender_handle.abort();
    log::info!("Animation WebSocket connection ended");
}

// Mock animation generator for testing
async fn generate_mock_animation_frames(
    session_id: String,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    _state: ServerState,
) -> Result<()> {
    log::info!("Generating mock animation frames for session: {}", session_id);

    // Generate 30 simple test frames at 30fps (1 second animation)
    let total_frames = 30;
    let frame_duration = Duration::from_millis(33); // 30 FPS

    for frame_num in 0..total_frames {
        // Create a simple test image (PNG)
        let width = 800;
        let height = 600;

        // Create gradient test pattern that changes over time
        let mut img_buffer = ImageBuffer::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let r = ((x + frame_num * 8) % 256) as u8;
                let g = ((y + frame_num * 4) % 256) as u8;
                let b = ((frame_num * 16) % 256) as u8;
                img_buffer.put_pixel(x, y, image::Rgba([r, g, b, 255]));
            }
        }

        // Encode as PNG
        let mut png_data = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut png_data);
            img_buffer.write_to(&mut cursor, ImageFormat::Png)?;
        }

        // Send frame via channel
        if frame_tx.send(png_data).is_err() {
            log::info!("Mock animation stopped - receiver dropped");
            break;
        }

        // Wait for next frame
        tokio::time::sleep(frame_duration).await;
    }

    log::info!("Mock animation complete for session: {}", session_id);
    Ok(())
}

async fn generate_animation_frames(
    request: AnimationStreamRequest,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    state: ServerState,
) -> Result<()> {
    // Get permit for rendering
    let _permit = state.render_semaphore.acquire().await?;

    log::info!("Generating animation frames with {}fps", request.animation_config.fps);

    // Create animated renderer
    let mut animated_renderer = match crate::animated_renderer::AnimatedPathTracer::new(
        request.animation_config.width.unwrap_or(1024),
        request.animation_config.height.unwrap_or(1024),
    ).await {
        Ok(renderer) => renderer,
        Err(e) => {
            log::error!("Failed to create animated renderer: {}", e);
            return Err(e);
        }
    };

    // Start animation with maze data
    animated_renderer.initialize_with_maze(&request.maze_data)?;

    let frame_duration = Duration::from_millis(1000 / request.animation_config.fps as u64);
    let mut frame_count = 0u32;

    loop {
        let frame_start = std::time::Instant::now();

        // Generate next frame
        match animated_renderer.update_and_render() {
            Ok(()) => {
                // Get frame data (this would need to be implemented in AnimatedPathTracer)
                // For now, create a mock frame
                let frame_data = vec![0u8; (request.animation_config.width.unwrap_or(1024) * 
                                            request.animation_config.height.unwrap_or(1024) * 
                                            4) as usize];
                
                // Convert frame to PNG bytes
                let png_bytes = frame_to_png_bytes(&frame_data,
                    request.animation_config.width.unwrap_or(1024),
                    request.animation_config.height.unwrap_or(1024))?;

                // Send frame (with backpressure handling in receiver)
                if frame_tx.send(png_bytes).is_err() {
                    break; // Client disconnected
                }

                frame_count += 1;
                log::debug!("Sent animation frame {}", frame_count);
                
                // Stop after reasonable number of frames for demo
                if frame_count >= 300 { // 10 seconds at 30fps
                    log::info!("Animation completed after {} frames", frame_count);
                    break;
                }
            }
            Err(e) => {
                log::error!("Failed to render frame: {}", e);
                break;
            }
        }

        // Frame rate limiting
        let frame_time = frame_start.elapsed();
        if frame_time < frame_duration {
            tokio::time::sleep(frame_duration - frame_time).await;
        }
    }

    Ok(())
}

fn frame_to_png_bytes(frame_data: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    // Convert RGBA frame data to PNG bytes
    let image_buffer = ImageBuffer::<Rgba<u8>, _>::from_raw(width, height, frame_data)
        .ok_or_else(|| anyhow!("Failed to create image buffer from frame data"))?;

    let mut png_bytes = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png_bytes);
        image_buffer.write_to(&mut cursor, ImageFormat::Png)
            .context("Failed to encode frame as PNG")?;
    }

    Ok(png_bytes)
}

// ============= CORS Configuration =============

fn with_cors() -> warp::cors::Builder {
    warp::cors()
        .allow_any_origin()  // In production, specify exact origins
        .allow_headers(vec![
            "Accept",
            "Accept-Language", 
            "Content-Type",
            "Authorization",
            "X-Requested-With",
        ])
        .allow_methods(vec!["GET", "POST", "OPTIONS"])
        .max_age(3600)
}

// ============= Middleware & Filters =============

fn with_state(state: ServerState) -> impl Filter<Extract = (ServerState,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || state.clone())
}

fn json_body() -> impl Filter<Extract = (RenderRequest,), Error = warp::Rejection> + Clone {
    warp::body::content_length_limit(1024 * 1024 * 10) // 10MB limit
        .and(warp::body::json())
}

// ============= Request Handlers =============

async fn handle_health() -> Result<impl Reply, Rejection> {
    Ok(warp::reply::json(&serde_json::json!({
        "status": "healthy",
        "service": "gpu-maze-renderer",
        "version": env!("CARGO_PKG_VERSION"),
        "timestamp": chrono::Utc::now().to_rfc3339(),
    })))
}

async fn handle_render(
    request: RenderRequest,
    state: ServerState,
) -> Result<impl Reply, Rejection> {
    // Validate request
    if request.width.unwrap_or(1024) > 4096 || request.height.unwrap_or(1024) > 4096 {
        return Err(warp::reject::custom(ServiceError {
            message: "Image dimensions too large (max 4096x4096)".to_string(),
            status_code: StatusCode::BAD_REQUEST,
        }));
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = request.session_id.clone()
        .unwrap_or_else(|| format!("gpu_{}", task_id));

    // Check if we're at capacity
    if state.render_semaphore.available_permits() == 0 {
        return Err(warp::reject::custom(ServiceError {
            message: "Server at capacity, please try again later".to_string(),
            status_code: StatusCode::SERVICE_UNAVAILABLE,
        }));
    }

    // Initialize task status
    {
        let mut tasks = state.tasks.write().await;
        tasks.insert(
            task_id.clone(),
            TaskStatus {
                session_id: session_id.clone(),
                status: "queued".to_string(),
                progress: 0.0,
                image_data: None,
                error: None,
                created_at: std::time::Instant::now(),
            },
        );
    }

    // Spawn rendering task
    let state_clone = state.clone();
    let task_id_clone = task_id.clone();
    tokio::spawn(async move {
        // Acquire semaphore permit
        let _permit = state_clone.render_semaphore.acquire().await;
        
        if let Err(e) = process_render_task(task_id_clone.clone(), request, state_clone.clone()).await {
            log::error!("Render task {} failed: {}", task_id_clone, e);
            let mut tasks = state_clone.tasks.write().await;
            if let Some(task) = tasks.get_mut(&task_id_clone) {
                task.status = "error".to_string();
                task.error = Some(format!("Rendering failed: {}", e));
            }
        }
    });

    // Get base URL from environment or use default
    let base_url = std::env::var("SERVICE_BASE_URL")
        .unwrap_or_else(|_| "https://gpu-maze-renderer-acn3zn6u4a-uc.a.run.app".to_string());

    Ok(warp::reply::json(&RenderResponse {
        task_id: task_id.clone(),
        session_id,
        status: "queued".to_string(),
        message: "Rendering task queued successfully".to_string(),
        status_url: format!("{}/status/{}", base_url, task_id),
        stream_url: None,
    }))
}

async fn process_render_task(
    task_id: String,
    request: RenderRequest,
    state: ServerState,
) -> Result<()> {
    // Add timeout for the entire render operation
    let render_timeout = Duration::from_secs(300); // 5 minutes

    timeout(render_timeout, async {
        // Update status to processing
        {
            let mut tasks = state.tasks.write().await;
            if let Some(task) = tasks.get_mut(&task_id) {
                task.status = "processing".to_string();
                task.progress = 0.1;
            }
        }

        let args = Args {
            maze: None,
            output: format!("/tmp/render_{}.png", task_id).into(),
            width: request.width.unwrap_or(1024),
            height: request.height.unwrap_or(1024),
            samples: request.samples.unwrap_or(256),
            gradient_test: false,
            vulkan: true,
            server: true,
            animated: false,
            test_materials: false,
        };

        // Create renderer
        let mut renderer = PathTracer::new(args.width, args.height, &args).await?;

        // Build scene
        {
            let mut tasks = state.tasks.write().await;
            if let Some(task) = tasks.get_mut(&task_id) {
                task.progress = 0.2;
            }
        }

        renderer.load_maze(&request.maze_data)?;

        // Render with progress updates
        for i in 0..args.samples {
            renderer.render_frame()?;

            // Update progress every 10 samples
            if i % 10 == 0 {
                let progress = 0.2 + (0.7 * i as f32 / args.samples as f32);
                let mut tasks = state.tasks.write().await;
                if let Some(task) = tasks.get_mut(&task_id) {
                    task.progress = progress;
                }
            }
        }

        // Save image
        {
            let mut tasks = state.tasks.write().await;
            if let Some(task) = tasks.get_mut(&task_id) {
                task.progress = 0.95;
            }
        }

        let image_data = renderer.save_image_to_buffer().await?;

        // Mark as completed
        {
            let mut tasks = state.tasks.write().await;
            if let Some(task) = tasks.get_mut(&task_id) {
                task.status = "completed".to_string();
                task.progress = 1.0;
                task.image_data = Some(image_data);
            }
        }

        log::info!("Rendering task {} completed successfully", task_id);
        Ok::<(), anyhow::Error>(())
    })
    .await
    .map_err(|_| anyhow::anyhow!("Render operation timed out"))?
}

async fn handle_status(
    task_id: String,
    state: ServerState,
) -> Result<impl Reply, Rejection> {
    let tasks = state.tasks.read().await;
    let base_url = std::env::var("SERVICE_BASE_URL")
        .unwrap_or_else(|_| "https://gpu-maze-renderer-acn3zn6u4a-uc.a.run.app".to_string());

    if let Some(task) = tasks.get(&task_id) {
        Ok(warp::reply::json(&StatusResponse {
            task_id: task_id.clone(),
            session_id: task.session_id.clone(),
            status: task.status.clone(),
            progress: Some(task.progress),
            image_url: if task.status == "completed" {
                Some(format!("{}/image/{}", base_url, task_id))
            } else {
                None
            },
            stream_url: if task.status == "completed" {
                Some(format!("{}/stream/{}", base_url, task_id))
            } else {
                None
            },
            error: task.error.clone(),
        }))
    } else {
        Err(warp::reject::custom(ServiceError {
            message: "Task not found".to_string(),
            status_code: StatusCode::NOT_FOUND,
        }))
    }
}

async fn handle_image(
    task_id: String,
    state: ServerState,
) -> Result<impl Reply, Rejection> {
    let tasks = state.tasks.read().await;

    if let Some(task) = tasks.get(&task_id) {
        if let Some(ref image_data) = task.image_data {
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "image/png")
                .header("Cache-Control", "public, max-age=3600")
                .header("Access-Control-Allow-Origin", "*")
                .body(image_data.clone())
                .unwrap())
        } else {
            Err(warp::reject::custom(ServiceError {
                message: "Image not yet available".to_string(),
                status_code: StatusCode::NOT_FOUND,
            }))
        }
    } else {
        Err(warp::reject::custom(ServiceError {
            message: "Task not found".to_string(),
            status_code: StatusCode::NOT_FOUND,
        }))
    }
}

async fn handle_stream(
    task_id: String,
    state: ServerState,
) -> Result<impl Reply, Rejection> {
    // This would implement WebRTC or chunked transfer for video streaming
    // For now, redirect to image endpoint
    handle_image(task_id, state).await
}

// ============= Server Initialization =============

pub async fn start_server() -> Result<()> {
    // Initialize logging
    env_logger::init();
    
    let state = ServerState::new();
    
    // Start background cleanup task
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            cleanup_state.cleanup_old_tasks().await;
            log::info!("Cleaned up old rendering tasks");
        }
    });

    // Health check endpoint
    let health = warp::path("health")
        .and(warp::get())
        .and_then(handle_health);

    // Render endpoint
    let render = warp::path("render")
        .and(warp::post())
        .and(json_body())
        .and(with_state(state.clone()))
        .and_then(handle_render);

    // Status endpoint
    let status = warp::path!("status" / String)
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(handle_status);

    // Image endpoint
    let image = warp::path!("image" / String)
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(handle_image);

    // Stream endpoint (for future video streaming)
    let stream = warp::path!("stream" / String)
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(handle_stream);

    // Animation WebSocket endpoint - matches frontend expectation
    let animation_ws = warp::path("stream")
        .and(warp::ws())
        .and(with_state(state.clone()))
        .map(|ws: warp::ws::Ws, state: ServerState| {
            ws.on_upgrade(move |websocket| handle_animation_stream(websocket, state))
        });

    // Combine all routes
    let routes = health
        .or(render)
        .or(status)
        .or(image)
        .or(stream)
        .or(animation_ws)
        .recover(handle_rejection)
        .with(with_cors())
        .with(warp::log("gpu_renderer"));

    // Get port from environment or use default (3030 for Backend #2)
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "3030".to_string())
        .parse::<u16>()
        .unwrap_or(3030);

    log::info!("Starting GPU renderer HTTP server on port {}", port);
    
    // Create the server and bind to address
    // NOTE: tcp_keepalive method has been removed in newer warp versions
    // The server will use default TCP settings
    let addr = ([0, 0, 0, 0], port);
    warp::serve(routes).run(addr).await;
    
    Ok(())
}
