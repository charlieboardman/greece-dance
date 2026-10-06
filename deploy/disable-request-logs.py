#!/usr/bin/env python3
"""Disable logs in the managed site, preserving Certbot settings and formatting."""
import re
import subprocess
import sys
from pathlib import Path


def disable_logs(source):
    # Tokenize comments, strings and escaped characters before interpreting braces.
    # ${variable} braces belong to a word, not a configuration block.
    lexer = re.compile(r'''\s+|\#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|(?:\\.|\$\{[^}]+\}|[^\s{};'"\#])+''')
    tokens = []
    position = 0
    for match in lexer.finditer(source):
        if match.start() != position:
            raise ValueError("Unsupported Nginx syntax; site left unchanged.")
        position = match.end()
        value = match.group()
        if not value.isspace() and not value.startswith("#"):
            tokens.append((value, match.start(), match.end()))
    if position != len(source):
        raise ValueError("Incomplete Nginx syntax; site left unchanged.")

    stack = []
    statement = []
    edits = []
    servers = 0
    for value, start, end in tokens:
        if value == "{":
            is_server = len(statement) == 1 and statement[0][0] == "server"
            stack.append({"server": is_server, "logs": set(), "insert": end})
            servers += int(is_server)
            statement = []
        elif value == ";":
            if statement and statement[0][0] in ("access_log", "error_log"):
                name = statement[0][0]
                replacement = "access_log off;" if name == "access_log" else "error_log /dev/null;"
                # Multiple log destinations must collapse to one directive per scope.
                if stack and name in stack[-1]["logs"]:
                    replacement = ""
                edits.append((statement[0][1], end, replacement))
                if stack:
                    stack[-1]["logs"].add(name)
            statement = []
        elif value == "}":
            if not stack or statement:
                raise ValueError("Unbalanced Nginx syntax; site left unchanged.")
            block = stack.pop()
            if block["server"]:
                missing = [name for name in ("access_log", "error_log") if name not in block["logs"]]
                text = "".join("\n    " + ("access_log off;" if name == "access_log" else "error_log /dev/null;") for name in missing)
                if text:
                    edits.append((block["insert"], block["insert"], text))
        else:
            statement.append((value, start, end))
    if stack or statement or not servers:
        raise ValueError("Expected complete Nginx server blocks; site left unchanged.")
    for start, end, text in sorted(edits, reverse=True):
        source = source[:start] + text + source[end:]
    return source


def main():
    site = Path(sys.argv[1])
    original = site.read_bytes()
    updated = disable_logs(original.decode()).encode()
    if updated == original:
        return
    # Preserve the existing inode's ownership, permissions, and enabled-site symlink.
    try:
        site.write_bytes(updated)
        subprocess.run(["nginx", "-t"], check=True)
    except BaseException:
        site.write_bytes(original)
        raise


if __name__ == "__main__":
    main()
