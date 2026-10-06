#!/usr/bin/env python3
"""Disable Nginx logs, preserving TLS settings, routing and file metadata."""
import re
import subprocess
import sys
from pathlib import Path


def disable_logs(source, require_servers=True, root=False):
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
    root_logs = set()
    for value, start, end in tokens:
        if value == "{":
            is_server = len(statement) == 1 and statement[0][0] == "server"
            defaults = len(statement) == 1 and statement[0][0] in ("server", "http", "stream")
            stack.append({"defaults": defaults, "logs": set(), "insert": end})
            servers += int(is_server)
            statement = []
        elif value == ";":
            if statement and statement[0][0] in ("access_log", "error_log"):
                name = statement[0][0]
                replacement = "access_log off;" if name == "access_log" else "error_log /dev/null;"
                # Multiple log destinations must collapse to one directive per scope.
                logs = stack[-1]["logs"] if stack else root_logs
                if name in logs:
                    replacement = ""
                edits.append((statement[0][1], end, replacement))
                logs.add(name)
            statement = []
        elif value == "}":
            if not stack or statement:
                raise ValueError("Unbalanced Nginx syntax; site left unchanged.")
            block = stack.pop()
            if block["defaults"]:
                missing = [name for name in ("access_log", "error_log") if name not in block["logs"]]
                text = "".join("\n    " + ("access_log off;" if name == "access_log" else "error_log /dev/null;") for name in missing)
                if text:
                    edits.append((block["insert"], block["insert"], text))
        else:
            statement.append((value, start, end))
    if stack or statement or (require_servers and not servers):
        raise ValueError("Expected complete Nginx server blocks; site left unchanged.")
    for start, end, text in sorted(edits, reverse=True):
        source = source[:start] + text + source[end:]
    if root and "error_log" not in root_logs:
        source = "error_log /dev/null;\n" + source
    return source


def main():
    all_configs = sys.argv[1] == "--all"
    if all_configs:
        # Nginx expands active includes, including default sites and TLS snippets.
        result = subprocess.run(["nginx", "-T"], check=True, capture_output=True, text=True)
        sites = list(dict.fromkeys(Path(name).resolve() for name in
                     re.findall(r"^# configuration file (.+):$", result.stdout, re.M)))
        if not sites:
            raise ValueError("Nginx did not report its active configuration files.")
    else:
        sites = [Path(sys.argv[1])]
    originals = {site: site.read_bytes() for site in sites}
    updates = {site: disable_logs(original.decode(), require_servers=not all_configs,
                                  root=all_configs and site == sites[0]).encode()
               for site, original in originals.items()}
    changed = [site for site in sites if updates[site] != originals[site]]
    if not changed:
        return
    # Preserve the existing inode's ownership, permissions, and enabled-site symlink.
    try:
        for site in changed:
            site.write_bytes(updates[site])
        subprocess.run(["nginx", "-t"], check=True)
    except BaseException:
        for site in changed:
            site.write_bytes(originals[site])
        raise


if __name__ == "__main__":
    main()
