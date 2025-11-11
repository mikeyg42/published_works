// types.rs - Shared type definitions for maze data structures
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MazeCell {
    pub id: String,
    pub q: i32,
    pub r: i32,
    pub s: i32,
    pub center: Point3,
    #[serde(rename = "isWall")]
    pub is_wall: bool,
    pub vertices: Vec<Point3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MazeDimensions {
    pub width: f32,
    pub height: f32,
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MazeData {
    #[serde(rename = "hexagons")]
    pub cells: Vec<MazeCell>,
    #[serde(rename = "graph")]
    pub connectivity: Vec<Vec<i32>>,
    pub solution: Option<Vec<String>>,
    pub dimensions: MazeDimensions,
}
