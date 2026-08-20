FROM python:3.13-slim
WORKDIR /app
COPY . /app
RUN useradd --system --uid 10001 trivial && mkdir -p /app/var && chown -R trivial:trivial /app/var
USER trivial
ENV TRIVIAL_HOST=0.0.0.0 TRIVIAL_PORT=8080 TRIVIAL_DATABASE=/app/var/trivial.sqlite3 TRIVIAL_SECURE_COOKIE=true
EXPOSE 8080
VOLUME ["/app/var"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["python3","-c","import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=3)"]
CMD ["python3","run.py"]
