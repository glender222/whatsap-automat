"""Build a downloadable kit with self-contained npm packages and a Python wheel."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / "packages"
LICENSE = ROOT / "LICENSE"
README = """# Kit de desarrollo de Whatsap-Automat

Los paquetes de Node incluyen sus dependencias de ejecución. Instálalos con Node.js 22.

```sh
npm install ./whatsap-automat-sdk-*.tgz ./whatsap-automat-cli-*.tgz
npx --no-install automat --help
```

Instala el SDK de Python en un entorno con Python 3.10 o posterior. pip instala `httpx` y `pydantic` desde el índice configurado.

```sh
python -m pip install ./whatsap_automat_sdk-*.whl
```

Usa la URL de tu instancia y un token de sesión para conectar el SDK. `SHA256SUMS` contiene los hashes de los archivos descargados.
"""


def stage_node_package(name, destination, contracts_version):
    source = PACKAGES / name
    destination.mkdir(parents=True)
    manifest = json.loads((source / "package.json").read_text(encoding="utf-8"))
    manifest.pop("devDependencies", None)
    manifest.pop("scripts", None)
    if "@whatsap-automat/contracts" in manifest["dependencies"]:
        manifest["dependencies"]["@whatsap-automat/contracts"] = contracts_version
    manifest["bundledDependencies"] = list(manifest["dependencies"])
    manifest["files"] = ["dist", "bin", "LICENSE"]
    (destination / "package.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    shutil.copytree(source / "dist", destination / "dist")
    if (source / "bin").is_dir():
        shutil.copytree(source / "bin", destination / "bin")
    shutil.copyfile(LICENSE, destination / "LICENSE")


def pack_node(name, workspace, downloads, contracts_version):
    target = workspace / name
    stage_node_package(name, target, contracts_version)
    contracts = target / "node_modules/@whatsap-automat/contracts"
    stage_node_package("contracts", contracts, contracts_version)
    zod_owner = target if name == "cli" else contracts
    zod_source = PACKAGES / ("cli" if name == "cli" else "contracts") / "node_modules/zod"
    shutil.copytree(zod_source, zod_owner / "node_modules/zod")
    packed = subprocess.check_output([
        "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(downloads),
    ], cwd=target, text=True)
    package = json.loads(packed)[0]
    packed_paths = {entry["path"] for entry in package["files"]}
    if "node_modules/@whatsap-automat/contracts/dist/index.js" not in packed_paths or not any(
        path.endswith("node_modules/zod/package.json") for path in packed_paths
    ):
        raise RuntimeError(f"Faltan dependencias de ejecución en {name}")
    return downloads / package["filename"]


def build(output):
    for package in ("contracts", "sdk", "cli"):
        subprocess.run(["npm", "--prefix", str(PACKAGES / package), "run", "build"], check=True)
    version = json.loads((PACKAGES / "contracts/package.json").read_text(encoding="utf-8"))["version"]
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="whatsap-kit-") as scratch:
        workspace = Path(scratch)
        downloads = workspace / "downloads"
        downloads.mkdir()
        artifacts = [pack_node(name, workspace, downloads, version) for name in ("sdk", "cli")]
        subprocess.run([
            sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(downloads),
            str(PACKAGES / "python-sdk"),
        ], check=True)
        wheels = list(downloads.glob("whatsap_automat_sdk-*.whl"))
        if len(wheels) != 1 or not zipfile.is_zipfile(wheels[0]):
            raise RuntimeError("No se generó una rueda válida del SDK de Python")
        artifacts += wheels
        (downloads / "README.md").write_text(README, encoding="utf-8")
        shutil.copyfile(LICENSE, downloads / "LICENSE.txt")
        artifacts += [downloads / "README.md", downloads / "LICENSE.txt"]
        hashes = "".join(f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n" for file in artifacts)
        with tempfile.TemporaryDirectory(dir=output.parent) as staging:
            archive = Path(staging) / output.name
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
                for file in artifacts:
                    bundle.writestr(file.name, file.read_bytes())
                bundle.writestr("SHA256SUMS", hashes)
            archive.replace(output)
    print(f"Kit de desarrollo generado en {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output)
