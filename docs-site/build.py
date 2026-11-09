"""Build the documentation portal from its explicitly listed source files."""

import json
import shutil
import tempfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SITE_FILES = ("index.html", "styles.css", "copy.js", "mark.svg")
DOWNLOADS = {
    "guia-inicio.md": HERE / "content/guia-inicio.md",
    "openapi.v1.json": ROOT / "docs/api/openapi.v1.json",
    "openapi.v1.yaml": ROOT / "docs/api/openapi.v1.yaml",
    "LICENSE.txt": ROOT / "LICENSE",
}


class SiteLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.targets = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        element_id = attributes.get("id")
        if element_id:
            if element_id in self.ids:
                raise ValueError(f"ID duplicado en el portal: {element_id}")
            self.ids.add(element_id)
        self.targets.extend(
            attributes[key] for key in ("href", "src", "data-copy") if key in attributes
        )


def validate_links(staging):
    links = SiteLinks()
    links.feed((staging / "index.html").read_text(encoding="utf-8"))
    for target in links.targets:
        if target in links.ids:
            continue
        url = urlsplit(target)
        if url.scheme or url.netloc:
            continue
        if url.fragment and url.fragment not in links.ids:
            raise ValueError(f"Enlace interno roto: {target}")
        if url.path and not (staging / url.path).is_file():
            raise ValueError(f"Archivo referenciado no disponible: {target}")


def build():
    with tempfile.TemporaryDirectory(dir=HERE) as temp:
        staging = Path(temp) / "site"
        downloads = staging / "downloads"
        downloads.mkdir(parents=True)
        for name in SITE_FILES:
            shutil.copyfile(HERE / "site" / name, staging / name)
        for name, source in DOWNLOADS.items():
            shutil.copyfile(source, downloads / name)

        spec = json.loads((downloads / "openapi.v1.json").read_text(encoding="utf-8"))
        if not spec.get("openapi", "").startswith("3.1.") or not spec.get("paths"):
            raise ValueError("OpenAPI debe declarar una especificación 3.1 con rutas")

        archive = downloads / "whatsap-automat-docs.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            for name in DOWNLOADS:
                bundle.writestr(zipfile.ZipInfo(name), (downloads / name).read_bytes(), zipfile.ZIP_DEFLATED)
        validate_links(staging)

        output = HERE / "dist"
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)

    print(f"Documentación generada en {output}")


if __name__ == "__main__":
    build()
