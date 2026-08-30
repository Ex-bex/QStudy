from pydantic_settings import BaseSettings
CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001"
class Settings(BaseSettings):
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7
    DATABASE_URL: str = "sqlite:///./studyhub.db"
    UPLOAD_DIR: str = "./uploads"
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.6-flash"   # если выдаст "model not found" — поменяй имя модели

    class Config:
        env_file = ".env"

settings = Settings()
