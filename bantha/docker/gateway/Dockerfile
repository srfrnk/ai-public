FROM alpine:3.20

RUN apk add --no-cache python3 py3-pip ca-certificates

WORKDIR /app
COPY gateway.py /app/gateway.py
RUN chmod +x /app/gateway.py

EXPOSE 8080 3000

USER nobody

ENTRYPOINT ["python3", "-u", "/app/gateway.py"]
