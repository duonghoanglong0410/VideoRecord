# ==============================================================================
# PackingProof Web — Backend (.NET 10 + FFmpeg/ffprobe) Production Dockerfile
# Build context: ./backend
# ==============================================================================
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY PackingProof.slnx ./
COPY src/PackingProof.Core/PackingProof.Core.csproj src/PackingProof.Core/
COPY src/PackingProof.Core/packages.lock.json src/PackingProof.Core/
COPY src/PackingProof.Infrastructure/PackingProof.Infrastructure.csproj src/PackingProof.Infrastructure/
COPY src/PackingProof.Infrastructure/packages.lock.json src/PackingProof.Infrastructure/
COPY src/PackingProof.Api/PackingProof.Api.csproj src/PackingProof.Api/
COPY src/PackingProof.Api/packages.lock.json src/PackingProof.Api/

RUN dotnet restore src/PackingProof.Api/PackingProof.Api.csproj --locked-mode

COPY src/ src/
RUN dotnet publish src/PackingProof.Api/PackingProof.Api.csproj \
    -c Release \
    -o /app/publish \
    --no-restore \
    /p:UseAppHost=false

# ==============================================================================
# Runtime Stage
# ==============================================================================
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

# Install ffmpeg (includes ffprobe), curl (for container healthcheck), and tzdata (Asia/Ho_Chi_Minh)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/packingproof/staging \
                /var/lib/packingproof/dataprotection-keys \
                /mnt/nas/packingproof

COPY --from=build /app/publish ./

ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_URLS=http://+:8080 \
    FFPROBE_PATH=ffprobe \
    FFMPEG_PATH=ffmpeg \
    STAGING_ROOT_PATH=/var/lib/packingproof/staging \
    DATA_PROTECTION_KEYS_PATH=/var/lib/packingproof/dataprotection-keys \
    NAS_ROOT_PATH=/mnt/nas/packingproof

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health/live || exit 1

ENTRYPOINT ["dotnet", "PackingProof.Api.dll"]
