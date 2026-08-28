"""Forced SSH command: expose only encrypted snapshots from one fixed directory.

Install this file outside the application, owned and writable only by the
operator. The directory argument is fixed in authorized_keys, never supplied by
the client. Incoming Python source is discarded, not interpreted.
"""

import base64
import datetime
import json
import os
import re
import select
import shlex
import stat
import sys
import time


MAX_BYTES = 2 * 1024 ** 3 + 36
MAX_ENTRIES = 4096
MAX_LIST_BYTES = 512 * 1024
MAX_STDIN_BYTES = 64 * 1024
NAME = re.compile(
    r"snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-"
    r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tseb"
)


def reject():
    raise ValueError()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result


def canonical(name):
    match = NAME.fullmatch(name) if isinstance(name, str) else None
    if not match:
        return False
    try:
        return datetime.datetime.strptime(
            match[1], "%Y-%m-%dT%H-%M-%SZ"
        ).strftime("%Y-%m-%dT%H-%M-%SZ") == match[1]
    except ValueError:
        return False


def request(allowed_directory):
    if (not allowed_directory.startswith("/") or allowed_directory == "/"
            or len(allowed_directory) > 4096
            or ".." in allowed_directory.split("/")
            or any(ord(char) < 32 or ord(char) == 127 for char in allowed_directory)):
        reject()
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if not original or len(original) > 16384:
        reject()
    tokens = shlex.split(original, comments=False, posix=True)
    if len(tokens) != 4 or tokens[:3] != ["python3", "-I", "-"]:
        reject()
    encoded = tokens[3].encode("ascii")
    decoded = base64.b64decode(encoded, validate=True)
    if base64.b64encode(decoded) != encoded:
        reject()
    parameters = json.loads(decoded.decode("utf-8"), object_pairs_hook=unique_object,
                            parse_constant=lambda _: reject())
    if type(parameters) is not dict or parameters.get("directory") != allowed_directory:
        reject()
    operation = parameters.get("operation")
    fields = {"directory", "operation"}
    if operation == "read":
        fields |= {"name", "bytes"}
        if (not canonical(parameters.get("name"))
                or type(parameters.get("bytes")) is not int
                or not 36 <= parameters["bytes"] <= MAX_BYTES):
            reject()
    elif operation != "list":
        reject()
    if set(parameters) != fields:
        reject()
    return parameters


def discard_source():
    # The ordinary transport sends a constant script on stdin. A forced command
    # must never run it, including when the holder of the SSH key changes it.
    deadline = time.monotonic() + 5
    received = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            reject()
        chunk = os.read(0, min(65536, MAX_STDIN_BYTES + 1 - received))
        if not chunk:
            return
        received += len(chunk)
        if received > MAX_STDIN_BYTES:
            reject()


def directory_fd(directory):
    root = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in filter(None, directory.split("/")):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=root)
            os.close(root)
            root = child
        if stat.S_IMODE(os.fstat(root).st_mode) != 0o700:
            reject()
        return root
    except BaseException:
        os.close(root)
        raise


def private_archive(info):
    return (stat.S_ISREG(info.st_mode) and not stat.S_IMODE(info.st_mode) & 0o077
            and 36 <= info.st_size <= MAX_BYTES)


def serve(parameters, root):
    if parameters["operation"] == "list":
        entries = []
        with os.scandir(root) as scan:
            for count, entry in enumerate(scan):
                if count >= MAX_ENTRIES:
                    reject()
                if not canonical(entry.name):
                    continue
                info = entry.stat(follow_symlinks=False)
                if private_archive(info):
                    entries.append({"name": entry.name, "bytes": info.st_size})
        result = json.dumps(entries, separators=(",", ":")).encode("utf-8")
        if len(result) > MAX_LIST_BYTES:
            reject()
        sys.stdout.buffer.write(result)
    else:
        fd = os.open(parameters["name"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=root)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not private_archive(info) or info.st_size != parameters["bytes"]:
                reject()
            remaining = info.st_size
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    reject()
                sys.stdout.buffer.write(chunk)
                remaining -= len(chunk)
            if source.read(1) or os.fstat(source.fileno()).st_size != info.st_size:
                reject()
    sys.stdout.buffer.flush()


def main():
    if len(sys.argv) != 2:
        reject()
    parameters = request(sys.argv[1])
    discard_source()
    root = directory_fd(sys.argv[1])
    try:
        serve(parameters, root)
    finally:
        os.close(root)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # No parser diagnostics, paths or buffered-output flush tracebacks.
        os._exit(1)
