"""Forbid reflection except the single documented Standalone console field replacement."""
from pathlib import Path
import re
import sys

source = Path(__file__).resolve().parents[1] / "src" / "main" / "java"
patterns = [
    r"java\.lang\.reflect", r"java\.lang\.invoke\.(?:MethodHandles|MethodHandle|VarHandle)",
    r"\bClass\s*\.\s*forName\s*\(",
    r"\.\s*(?:get(?:Declared)?(?:Field|Fields|Method|Methods|Constructor|Constructors)|setAccessible|trySetAccessible|newInstance)\s*\(",
    r"\.\s*fromJson\s*\(",
    r"\bProcessBuilder\b",
]
console_exception = {
    'import java.lang.reflect.Field;',
    'Field loggerField = GeyserStandaloneBootstrap.class.getDeclaredField("geyserLogger");',
    'if (!loggerField.trySetAccessible())',
}
violations = []
files = list(source.rglob("*.java"))
if not files:
    sys.exit("No extension sources found")
for path in files:
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if path.name == "StandaloneConsoleGuard.java" and line.strip() in console_exception:
            continue
        if any(re.search(pattern, line) for pattern in patterns):
            violations.append(f"{path.relative_to(source)}:{number}: reflection outside the console exception or external process execution")
if violations:
    sys.exit("\n".join(violations))
print(f"PASS reflection limited to the Standalone console field; no external commands in {len(files)} extension source files")
