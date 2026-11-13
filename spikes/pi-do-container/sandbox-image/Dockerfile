# PROTOTYPE, throwaway: the agent's sandbox. No secrets live here.
FROM --platform=linux/amd64 debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bash coreutils \
    && rm -rf /var/lib/apt/lists/*
COPY pi-env /usr/local/bin/pi-env
RUN chmod +x /usr/local/bin/pi-env && mkdir -p /workspace && git -C /workspace init -q
WORKDIR /workspace
# Each fresh container writes a new boot marker, so the session can detect a reset workspace.
CMD ["sh", "-c", "date -u +%s%N > /workspace/.boot && exec sleep infinity"]
