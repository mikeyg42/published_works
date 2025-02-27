from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.api.routes import router  # Use absolute import

app = FastAPI()

# Configure CORS for local development (support multiple origins)
origins = [
    "http://localhost:4200",  # Angular frontend
    "http://127.0.0.1:8000"   # Local FastAPI server
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include the router
app.include_router(router)

@app.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "healthy"}