from typing import List, Dict
from pydantic import BaseModel

class Component(BaseModel):
    adjacency_list: Dict[str, List[str]]

class LargeMazeData(BaseModel):
    largeComponents: List[Component]

class SolutionResponse(BaseModel):
    type: str
    data: List[List[str]]

class ErrorResponse(BaseModel):
    type: str
    error: str
