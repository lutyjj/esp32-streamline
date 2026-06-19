from pathlib import Path

Import("env")


project_dir = Path(env.subst("$PROJECT_DIR"))
html_path = project_dir / "web" / "index.html"
header_path = project_dir / "src" / "generated_web_ui.h"
delimiter = "ESP32LINEIN"

html = html_path.read_text(encoding="utf-8")
if f"){delimiter}\"" in html:
    raise RuntimeError(f"{html_path} contains the raw-string delimiter {delimiter}")

header = f"""#pragma once

#include <pgmspace.h>

static const char WEB_INDEX_HTML[] PROGMEM = R"{delimiter}({html}){delimiter}";
"""

header_path.write_text(header, encoding="utf-8")
