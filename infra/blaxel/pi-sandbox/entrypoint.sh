#!/bin/sh

export PATH="/usr/local/bin:/app/node_modules/.bin:$PATH"

/usr/local/bin/sandbox-api &

wait_for_port() {
    port=$1
    timeout=30
    count=0

    echo "Waiting for port $port to be available..."

    while ! nc -z 127.0.0.1 "$port"; do
        sleep 1
        count=$((count + 1))
        if [ "$count" -gt "$timeout" ]; then
            echo "Timeout waiting for port $port"
            exit 1
        fi
    done

    echo "Port $port is now available"
}

wait_for_port 8080

echo "Running Next.js dev server..."
curl http://localhost:8080/process -X POST -d '{"workingDir": "/app", "command": "npm run dev -- --port 3000", "waitForCompletion": false}' -H "Content-Type: application/json"

wait
