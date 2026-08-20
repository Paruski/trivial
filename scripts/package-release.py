import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_PARTS = {".git", ".github", "__pycache__", "node_modules", "playwright-report", "test-results", "var", "dist"}
EXCLUDED_NAMES = {".env", ".DS_Store"}


def main():
    target = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "dist" / "trivial-server.zip").resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(ROOT.rglob("*")):
            relative = path.relative_to(ROOT)
            if not path.is_file() or path.name in EXCLUDED_NAMES or any(part in EXCLUDED_PARTS for part in relative.parts):
                continue
            archive.write(path, Path("trivial") / relative)
    print(f"{target} · {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
