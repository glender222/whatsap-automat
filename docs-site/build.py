"""Build the documentation portal from its explicitly listed source files."""

import argparse
import hashlib
import json
import re
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


def validate_developer_kit(path):
    with zipfile.ZipFile(path) as kit:
        names = kit.namelist()
        if len(names) != 6 or len(set(names)) != len(names) or kit.testzip() is not None:
            raise ValueError("El kit de desarrollo tiene archivos incompletos o repetidos")
        checksums = {}
        for line in kit.read("SHA256SUMS").decode("utf-8").splitlines():
            expected, name = line.split("  ", 1)
            if name in checksums:
                raise ValueError("El kit de desarrollo contiene una suma repetida")
            checksums[name] = expected
        if set(checksums) != set(names) - {"SHA256SUMS"}:
            raise ValueError("El kit de desarrollo requiere una suma por archivo")
        for name, expected in checksums.items():
            if not re.fullmatch(r"[a-zA-Z0-9_.-]+", name) or name in {".", ".."}:
                raise ValueError("El kit de desarrollo contiene una ruta inválida")
            if hashlib.sha256(kit.read(name)).hexdigest() != expected:
                raise ValueError(f"No coincide la suma SHA-256 de {name}")


def build(developer_kit=None):
    with tempfile.TemporaryDirectory(dir=HERE) as temp:
        staging = Path(temp) / "site"
        downloads = staging / "downloads"
        downloads.mkdir(parents=True)
        for name in SITE_FILES:
            shutil.copyfile(HERE / "site" / name, staging / name)
        for name, source in DOWNLOADS.items():
            shutil.copyfile(source, downloads / name)

        if developer_kit is not None:
            validate_developer_kit(developer_kit)
            shutil.copyfile(developer_kit, downloads / "whatsap-automat-developer-kit.zip")
        else:
            index = staging / "index.html"
            index.write_text(re.sub(
                r"^ *<!-- developer-kit:start -->.*?<!-- developer-kit:end -->\n", "",
                index.read_text(encoding="utf-8"), flags=re.MULTILINE | re.DOTALL,
            ), encoding="utf-8")

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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--developer-kit", type=Path)
    build(parser.parse_args().developer_kit)
