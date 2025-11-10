"""
Advanced Maze Caching with Redis Sorted Sets
Implements efficient range-based maze caching with device exclusion and dynamic resizing.
Uses precise mathematical calculations to avoid rounding error propagation.
"""

import hashlib
import json
import math
import random
import struct
import time
import logging
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple, Any
import redis.asyncio as redis

from .config import get_redis_config
from .client import OptimizedRedisCache

logger = logging.getLogger(__name__)

# ==============================================================================
# CONFIGURATION CONSTANTS - All hardcoded values centralized here
# ==============================================================================

# Hexagon size constraints (radius in pixels) - matches frontend maze generator
MIN_HEX_RADIUS = 8.0    # ~15px width / sqrt(3) - matches MIN_HEXAGON_WIDTH
MAX_HEX_RADIUS = 75.0   # ~130px width / sqrt(3) - matches MAX_RADIUS

# Padding configuration (pixels)
BASE_PADDING = 15       # Base padding amount
PADDING_VARIANCE = 5    # Random variance: padding will be BASE_PADDING ± PADDING_VARIANCE

# Cache configuration
DEFAULT_CACHE_TTL = 3600  # 1 hour default TTL
MAX_COMPATIBLE_RESULTS = 10  # Maximum compatible mazes to return

# Mathematical constants for pointy-top hexagons
SQRT3 = math.sqrt(3)
HEX_ROW_VERTICAL_SPACING_FACTOR = 0.75  # Vertical spacing is 3/4 of hex height

# Quality scoring weights
SCORE_WEIGHTS = {
    'dimension_match': 40,  # How well dimensions match (0-40 points)
    'recency': 20,         # How recent the maze is (0-20 points)
    'complexity': 20,      # Maze complexity score (0-20 points)
    'hex_size': 20         # How well hex size matches (0-20 points)
}


# ==============================================================================
# HEXAGON MATHEMATICS - Precise calculations without rounding error propagation
# ==============================================================================

class HexagonMath:
    """Pure functions for hexagon mathematics with precise calculations."""

    @staticmethod
    def radius_to_width(radius: float) -> float:
        """Convert hex radius to width (flat-to-flat distance)"""
        return radius * SQRT3

    @staticmethod
    def width_to_radius(width: float) -> float:
        """Convert hex width to radius"""
        return width / SQRT3

    @staticmethod
    def radius_to_height(radius: float) -> float:
        """Convert hex radius to height (point-to-point distance)"""
        return radius * 2.0

    @staticmethod
    def calculate_canvas_width(cols: int, hex_radius: float, padding: int) -> int:
        """Calculate required canvas width for given grid and hex size"""
        hex_width = HexagonMath.radius_to_width(hex_radius)
        required_width = (cols + 0.5) * hex_width + (2 * padding)
        return int(round(required_width))

    @staticmethod
    def calculate_canvas_height(rows: int, hex_radius: float, padding: int) -> int:
        """Calculate required canvas height for given grid and hex size"""
        hex_height = HexagonMath.radius_to_height(hex_radius)
        vertical_spacing = hex_height * HEX_ROW_VERTICAL_SPACING_FACTOR
        required_height = rows * vertical_spacing + (2 * padding)
        return int(round(required_height))

    @staticmethod
    def calculate_optimal_hex_radius(
        target_width: int,
        target_height: int,
        rows: int,
        cols: int,
        padding: int
    ) -> float:
        """Calculate optimal hex radius for target canvas dimensions"""
        # Calculate radius based on width constraint
        available_width = target_width - (2 * padding)
        width_based_radius = HexagonMath.width_to_radius(available_width / (cols + 0.5))

        # Calculate radius based on height constraint
        available_height = target_height - (2 * padding)
        vertical_spacing_needed = available_height / rows
        height_based_radius = vertical_spacing_needed / (2 * HEX_ROW_VERTICAL_SPACING_FACTOR)

        # Take the smaller radius to ensure both constraints are met
        optimal_radius = min(width_based_radius, height_based_radius)

        # Clamp to valid range
        return max(MIN_HEX_RADIUS, min(MAX_HEX_RADIUS, optimal_radius))


# ==============================================================================
# DATA STRUCTURES
# ==============================================================================

@dataclass
class CanvasRange:
    """Canvas size range that a cached maze can support"""
    min_width: int
    max_width: int
    min_height: int
    max_height: int

    def contains(self, width: int, height: int) -> bool:
        """Check if canvas dimensions fit within this range"""
        return (
            self.min_width <= width <= self.max_width and
            self.min_height <= height <= self.max_height
        )

    def area(self) -> int:
        """Calculate range area for quality scoring"""
        return (self.max_width - self.min_width) * (self.max_height - self.min_height)


@dataclass
class CachedMazeInfo:
    """Metadata about a cached maze for smart retrieval"""
    session_id: str
    rows: int
    cols: int
    original_hex_radius: float
    canvas_range: CanvasRange
    device_hash: str
    created_at: float
    padding_used: int
    solution_count: int
    maze_complexity_score: float


# ==============================================================================
# MAIN CACHE CLASS
# ==============================================================================

class MazeCache:
    """
    Advanced maze cache using Redis Sorted Sets for efficient range queries.

    Features:
    - Precise hexagon mathematics without rounding error propagation
    - Random padding variation to avoid identical-looking mazes
    - Device exclusion to prevent users getting their own mazes
    - Dynamic hex size calculation during retrieval
    - Quality-based maze selection
    """

    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client

    def _generate_device_hash(self, request_info: Dict[str, str]) -> str:
        """Generate stable device identifier from request fingerprinting data"""
        device_string = ":".join([
            request_info.get('ip', 'unknown'),
            request_info.get('user_agent', '')[:50],  # Limit length
            request_info.get('accept_language', '')[:20]
        ])
        return hashlib.sha256(device_string.encode()).hexdigest()[:16]

    def _generate_random_padding(self) -> int:
        """Generate random padding amount within configured variance"""
        return random.randint(
            BASE_PADDING - PADDING_VARIANCE,
            BASE_PADDING + PADDING_VARIANCE
        )

    def _calculate_canvas_range(self, rows: int, cols: int, padding: int) -> CanvasRange:
        """
        Calculate the range of canvas sizes that can accommodate this maze grid.
        Uses precise mathematics with hex radius bounds.
        """
        # Calculate range using min/max hex radius (no intermediate rounding)
        min_width = HexagonMath.calculate_canvas_width(cols, MIN_HEX_RADIUS, padding)
        max_width = HexagonMath.calculate_canvas_width(cols, MAX_HEX_RADIUS, padding)
        min_height = HexagonMath.calculate_canvas_height(rows, MIN_HEX_RADIUS, padding)
        max_height = HexagonMath.calculate_canvas_height(rows, MAX_HEX_RADIUS, padding)

        return CanvasRange(
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height
        )

    def _calculate_quality_score(
        self,
        cached_info: CachedMazeInfo,
        target_width: int,
        target_height: int,
        optimal_hex_radius: float
    ) -> float:
        """
        Calculate quality score for maze compatibility.
        Higher score = better match.
        """
        score = 0.0

        # Dimension match score (0-40 points)
        canvas_center_width = (cached_info.canvas_range.min_width + cached_info.canvas_range.max_width) / 2
        canvas_center_height = (cached_info.canvas_range.min_height + cached_info.canvas_range.max_height) / 2

        width_diff = abs(canvas_center_width - target_width) / target_width
        height_diff = abs(canvas_center_height - target_height) / target_height
        dimension_score = SCORE_WEIGHTS['dimension_match'] * (1 - (width_diff + height_diff) / 2)
        score += max(0, dimension_score)

        # Recency score (0-20 points) - lose points over time
        age_hours = (time.time() - cached_info.created_at) / 3600
        recency_score = SCORE_WEIGHTS['recency'] * max(0, 1 - age_hours / 24)  # Full points for <1 hour, 0 after 24h
        score += recency_score

        # Complexity score (0-20 points) - more complex mazes are more valuable
        complexity_score = SCORE_WEIGHTS['complexity'] * min(1.0, cached_info.maze_complexity_score / 100)
        score += complexity_score

        # Hex size compatibility score (0-20 points)
        hex_size_diff = abs(cached_info.original_hex_radius - optimal_hex_radius) / optimal_hex_radius
        hex_score = SCORE_WEIGHTS['hex_size'] * max(0, 1 - hex_size_diff)
        score += hex_score

        return score

    def _encode_sorted_set_score(
        self,
        min_height: int,
        max_height: int,
        priority: int = 50
    ) -> float:
        """
        Encode height range and priority into Redis sorted set score.
        Uses fixed-width encoding to prevent collisions.
        """
        # Ensure values fit in allocated digits
        min_height = max(0, min(99999, min_height))  # 5 digits max
        max_height = max(0, min(99999, max_height))  # 5 digits max
        priority = max(0, min(99, priority))         # 2 digits max

        # Format: MMMMMNNNNPP (12 digits total)
        score_int = min_height * 10000000 + max_height * 100 + priority
        return float(score_int)

    def _decode_sorted_set_score(self, score: float) -> Tuple[int, int, int]:
        """Decode sorted set score back to height range and priority"""
        score_int = int(score)
        priority = score_int % 100
        score_int //= 100
        max_height = score_int % 100000
        min_height = score_int // 100000
        return min_height, max_height, priority

    async def find_compatible_mazes(
        self,
        target_width: int,
        target_height: int,
        request_info: Dict[str, str],
        max_results: int = MAX_COMPATIBLE_RESULTS
    ) -> List[Tuple[CachedMazeInfo, float, float]]:
        """
        Find cached mazes compatible with target canvas dimensions.

        Returns:
            List of (cached_maze_info, optimal_hex_radius, quality_score) tuples
            sorted by quality score (best first)
        """
        device_hash = self._generate_device_hash(request_info)
        compatible_mazes = []

        try:
            # Find all width ranges that could contain our target width
            width_pattern = "cache:width_range:*"

            async for key in self.redis.scan_iter(match=width_pattern, count=100):
                try:
                    # Parse width range from key
                    key_parts = key.split(":")
                    if len(key_parts) != 3:
                        continue

                    width_range_part = key_parts[2]  # "min_width-max_width"
                    min_width, max_width = map(int, width_range_part.split("-"))

                    # Check if target width fits in this range
                    if not (min_width <= target_width <= max_width):
                        continue

                    # Get all maze entries in this width range
                    range_entries = await self.redis.zrange(key, 0, -1, withscores=True)

                    for member, score in range_entries:
                        min_height, max_height, priority = self._decode_sorted_set_score(score)

                        # Check if target height fits in height range
                        if not (min_height <= target_height <= max_height):
                            continue

                        # Parse member: "session_id:device_hash:timestamp"
                        member_parts = member.split(":")
                        if len(member_parts) < 3:
                            continue

                        session_id = member_parts[0]
                        entry_device_hash = member_parts[1]

                        # Skip mazes from same device
                        if entry_device_hash == device_hash:
                            continue

                        # Retrieve full maze metadata
                        cached_info = await self._get_maze_metadata(session_id)
                        if not cached_info:
                            continue

                        # Calculate optimal hex size for this target
                        optimal_hex_radius = HexagonMath.calculate_optimal_hex_radius(
                            target_width, target_height,
                            cached_info.rows, cached_info.cols,
                            cached_info.padding_used
                        )

                        # Calculate quality score
                        quality_score = self._calculate_quality_score(
                            cached_info, target_width, target_height, optimal_hex_radius
                        )

                        compatible_mazes.append((cached_info, optimal_hex_radius, quality_score))

                except (ValueError, IndexError, TypeError) as e:
                    logger.debug(f"Error processing cache key {key}: {e}")
                    continue

            # Sort by quality score (best first) and limit results
            compatible_mazes.sort(key=lambda x: x[2], reverse=True)
            return compatible_mazes[:max_results]

        except Exception as e:
            logger.error(f"Error finding compatible mazes: {e}")
            return []

    async def cache_maze(
        self,
        session_id: str,
        maze_data: Dict[str, Any],
        solutions: List[List[str]],
        request_info: Dict[str, str],
        ttl: int = DEFAULT_CACHE_TTL
    ) -> bool:
        """
        Cache maze with range-based indexing and random padding variation.
        """
        try:
            # Extract maze dimensions
            dimensions = maze_data.get('dimensions', {})
            rows = dimensions.get('rows', 0)
            cols = dimensions.get('cols', 0)

            if rows <= 0 or cols <= 0:
                logger.warning(f"Invalid maze dimensions: {rows}x{cols}")
                return False

            # Generate random padding for visual variety
            padding = self._generate_random_padding()

            # Calculate original hex size from maze data
            hex_width = dimensions.get('hexWidth', 0)
            original_hex_radius = HexagonMath.width_to_radius(hex_width) if hex_width > 0 else MIN_HEX_RADIUS

            # Calculate canvas range this maze can support
            canvas_range = self._calculate_canvas_range(rows, cols, padding)

            # Generate identifiers
            device_hash = self._generate_device_hash(request_info)
            timestamp = int(time.time())

            # Calculate maze complexity score
            complexity_score = self._calculate_complexity_score(maze_data, solutions)

            # Create cache metadata
            cache_info = CachedMazeInfo(
                session_id=session_id,
                rows=rows,
                cols=cols,
                original_hex_radius=original_hex_radius,
                canvas_range=canvas_range,
                device_hash=device_hash,
                created_at=time.time(),
                padding_used=padding,
                solution_count=len(solutions),
                maze_complexity_score=complexity_score
            )

            # Store in Redis pipeline for atomicity
            pipeline = self.redis.pipeline()

            # 1. Store maze metadata
            metadata_key = f"cache:maze_meta:{session_id}"
            pipeline.set(metadata_key, json.dumps(asdict(cache_info)), ex=ttl)

            # 2. Store actual maze data
            data_key = f"cache:maze_data:{session_id}"
            maze_payload = {
                'maze_data': maze_data,
                'solutions': solutions
            }
            pipeline.set(data_key, json.dumps(maze_payload), ex=ttl)

            # 3. Add to width-based range index
            width_range_key = f"cache:width_range:{canvas_range.min_width}-{canvas_range.max_width}"
            priority = min(99, int(original_hex_radius))  # Use hex size as priority
            score = self._encode_sorted_set_score(
                canvas_range.min_height,
                canvas_range.max_height,
                priority
            )
            member = f"{session_id}:{device_hash}:{timestamp}"

            pipeline.zadd(width_range_key, {member: score})
            pipeline.expire(width_range_key, ttl)

            # 4. Add to device index (for cleanup and stats)
            device_key = f"cache:device:{device_hash}"
            pipeline.sadd(device_key, session_id)
            pipeline.expire(device_key, ttl)

            # Execute pipeline
            await pipeline.execute()

            logger.info(
                f"Cached maze {session_id}: {rows}x{cols} grid, "
                f"canvas range {canvas_range.min_width}-{canvas_range.max_width}x"
                f"{canvas_range.min_height}-{canvas_range.max_height}, "
                f"padding {padding}px, device {device_hash[:8]}"
            )

            return True

        except Exception as e:
            logger.error(f"Error caching maze {session_id}: {e}")
            return False

    async def _get_maze_metadata(self, session_id: str) -> Optional[CachedMazeInfo]:
        """Retrieve maze metadata from Redis"""
        try:
            metadata_key = f"cache:maze_meta:{session_id}"
            data = await self.redis.get(metadata_key)

            if not data:
                return None

            metadata_dict = json.loads(data)

            # Reconstruct CanvasRange
            canvas_range_dict = metadata_dict['canvas_range']
            canvas_range = CanvasRange(**canvas_range_dict)
            metadata_dict['canvas_range'] = canvas_range

            return CachedMazeInfo(**metadata_dict)

        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.debug(f"Error retrieving metadata for {session_id}: {e}")
            return None

    async def retrieve_maze_data(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve full maze data from cache"""
        try:
            data_key = f"cache:maze_data:{session_id}"
            data = await self.redis.get(data_key)

            if not data:
                return None

            return json.loads(data)

        except (json.JSONDecodeError, TypeError) as e:
            logger.debug(f"Error retrieving maze data for {session_id}: {e}")
            return None

    def _calculate_complexity_score(
        self,
        maze_data: Dict[str, Any],
        solutions: List[List[str]]
    ) -> float:
        """Calculate maze complexity score for quality ranking"""
        if not solutions:
            return 0.0

        # Component count contributes to complexity
        components = maze_data.get('components', [])
        component_score = min(50, len(components) * 5)  # Max 50 points for components

        # Solution path lengths contribute to complexity
        total_path_length = sum(len(path) for path in solutions)
        avg_path_length = total_path_length / len(solutions) if solutions else 0
        path_score = min(50, avg_path_length * 2)  # Max 50 points for path complexity

        return component_score + path_score

    async def get_cache_stats(self) -> Dict[str, Any]:
        """Get comprehensive cache statistics"""
        try:
            stats = {
                'total_cached_mazes': 0,
                'width_ranges': 0,
                'devices_with_caches': 0,
                'avg_maze_age_hours': 0,
                'complexity_distribution': {'simple': 0, 'medium': 0, 'complex': 0}
            }

            # Count width range keys
            width_pattern = "cache:width_range:*"
            stats['width_ranges'] = len([key async for key in self.redis.scan_iter(match=width_pattern)])

            # Count device keys
            device_pattern = "cache:device:*"
            stats['devices_with_caches'] = len([key async for key in self.redis.scan_iter(match=device_pattern)])

            # Analyze maze metadata
            meta_pattern = "cache:maze_meta:*"
            total_age = 0
            maze_count = 0

            async for key in self.redis.scan_iter(match=meta_pattern, count=50):
                try:
                    metadata = await self._get_maze_metadata(key.split(":")[-1])
                    if metadata:
                        maze_count += 1
                        age_hours = (time.time() - metadata.created_at) / 3600
                        total_age += age_hours

                        # Categorize complexity
                        if metadata.maze_complexity_score < 30:
                            stats['complexity_distribution']['simple'] += 1
                        elif metadata.maze_complexity_score < 70:
                            stats['complexity_distribution']['medium'] += 1
                        else:
                            stats['complexity_distribution']['complex'] += 1

                except Exception:
                    continue

            stats['total_cached_mazes'] = maze_count
            stats['avg_maze_age_hours'] = total_age / maze_count if maze_count > 0 else 0

            return stats

        except Exception as e:
            logger.error(f"Error getting cache stats: {e}")
            return {'error': str(e)}


# ==============================================================================
# CONVENIENCE FUNCTIONS
# ==============================================================================

async def create_maze_cache(redis_client: redis.Redis) -> MazeCache:
    """Factory function to create a MazeCache instance"""
    return MazeCache(redis_client)