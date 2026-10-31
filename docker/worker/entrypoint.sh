#!/bin/bash
set -e

# Create isolate directories
mkdir -p /var/local/lib/isolate /run/isolate

# Set up cgroup v2 for isolate only if running in an isolate worker and cgroup fs is writable
if [ "${WORKER_TYPE:-}" = "isolate" ] && [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # Create a leaf cgroup for the worker process
    if mkdir -p /sys/fs/cgroup/worker 2>/dev/null; then
        # Move current shell into the worker cgroup
        # so the root cgroup has no direct processes
        if ! echo $$ > /sys/fs/cgroup/worker/cgroup.procs 2>/dev/null; then
            echo "WARNING: Failed to move process to worker cgroup" >&2
        fi

        # Enable controllers at root level (needs no processes in root)
        if ! echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
            echo "WARNING: Failed to enable cgroup controllers at root" >&2
        fi

        # Create dedicated cgroup subtree for isolate boxes
        mkdir -p /sys/fs/cgroup/isolate
        if ! echo "+cpu +memory +pids" > /sys/fs/cgroup/isolate/cgroup.subtree_control 2>/dev/null; then
            echo "WARNING: Failed to enable cgroup controllers for isolate" >&2
        fi

        echo "Cgroup v2 setup complete for isolate"
    else
        echo "INFO: /sys/fs/cgroup is not writable, skipping cgroup v2 setup"
    fi
fi

exec "$@"
