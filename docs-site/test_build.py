"""Regression checks for links across the public product and documentation pages."""

import tempfile
import unittest
from pathlib import Path

from build import validate_links


class WebsiteLinksTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.site = Path(self.directory.name)

    def write(self, name, content):
        path = self.site / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_cross_page_fragments_assets_and_external_links(self):
        self.write("index.html", '<a href="docs.html#api">API</a><img src="assets/product.webp"><a href="https://example.com/missing#remote">External</a>')
        self.write("docs.html", '<h2 id="api">API</h2><a href="index.html">Home</a>')
        self.write("assets/product.webp", "fixture")
        validate_links(self.site)

    def test_fragment_must_belong_to_destination_page(self):
        self.write("index.html", '<h2 id="api">Local</h2><a href="docs.html#api">API</a>')
        self.write("docs.html", '<h2 id="setup">Setup</h2>')
        with self.assertRaisesRegex(ValueError, "Enlace interno roto"):
            validate_links(self.site)

    def test_broken_links_on_documentation_are_checked(self):
        self.write("index.html", '<a href="docs.html">Docs</a>')
        self.write("docs.html", '<a href="downloads/missing.zip">Download</a>')
        with self.assertRaisesRegex(ValueError, "Archivo referenciado"):
            validate_links(self.site)

    def test_cannot_link_files_outside_the_public_bundle(self):
        self.write("index.html", '<a href="../private.env">Private</a>')
        with self.assertRaisesRegex(ValueError, "Archivo referenciado"):
            validate_links(self.site)

    def test_duplicate_identifiers_are_rejected_per_page(self):
        self.write("index.html", '<h1 id="hero">Title</h1><h2 id="hero">Another</h2>')
        with self.assertRaisesRegex(ValueError, "ID duplicado"):
            validate_links(self.site)

    def test_copy_targets_and_same_page_fragments(self):
        self.write("index.html", '<button data-copy="snippet">Copy</button><code id="snippet">code</code><a href="#snippet">Example</a>')
        validate_links(self.site)


if __name__ == "__main__":
    unittest.main()
