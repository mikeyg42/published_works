# backend/models.py
from typing import List, Dict, Optional
from pydantic import BaseModel, Field

class Component(BaseModel):
    adjacency_list: Dict[str, List[str]]

class LargeMazeData(BaseModel):
    largeComponents: List[Component] = Field(..., min_length=1, description="Must contain at least one component.")

class SolutionResponse(BaseModel):
    type: str
    data: List[List[str]]

class ErrorResponse(BaseModel):
    type: str
    error: Optional[str] = None  # Optional to allow flexibility
