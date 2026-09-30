"""
Cython build configuration for pypsx.

Compiles all implementation modules into platform-specific binary extensions
(.pyd on Windows, .so on Linux/macOS). __init__.py, models.py, and constants.py
are intentionally excluded so they remain as plain-text Python re-exporters.
"""
import os
import glob
from setuptools import setup, Extension, find_packages
from setuptools.command.build_py import build_py as _build_py
from Cython.Build import cythonize

# Stems that must stay as plain Python (pickling, isinstance, re-exports)
EXCLUDE_STEMS = {"__init__", "constants", "models"}

# Folders to skip entirely
EXCLUDE_DIRS = {"backend", "build", "dist", "tests", "__pycache__", ".git"}


# os.name == "nt" does not imply MSVC -- CC/CXX may point at a mingw
# toolchain (e.g. w64devkit) for local builds without Visual Studio, and
# mingw's gcc/g++ reject MSVC-style "/O2" the same way MSVC would reject "-O2".
_USING_MSVC = os.name == "nt" and "gcc" not in os.environ.get("CC", "").lower()
_OPT_FLAG = "/O2" if _USING_MSVC else "-O2"


def collect_extensions(pkg_root: str):
    extensions = []
    for path in glob.glob(f"{pkg_root}/**/*.py", recursive=True):
        # Normalise separators
        norm = path.replace("\\", "/")

        # Skip excluded directories
        parts = norm.split("/")
        if any(p in EXCLUDE_DIRS for p in parts):
            continue

        stem = os.path.splitext(os.path.basename(path))[0]
        if stem in EXCLUDE_STEMS:
            continue

        # Convert path to dotted module name (e.g. pypsx/core/fetchers.py -> pypsx.core.fetchers)
        module = norm.replace("/", ".")[:-3]
        extensions.append(
            Extension(
                module,
                [path],
                extra_compile_args=[_OPT_FLAG],
            )
        )
    return extensions


class build_py(_build_py):
    """
    Drop .py source for modules that get Cython-compiled, so wheels ship only
    the compiled extension (+ .pyi stub) for them -- MANIFEST.in's
    include/exclude rules only govern sdist content, NOT bdist_wheel, so
    without this override every wheel ships the full readable .py source
    right alongside the .pyd/.so, silently defeating the whole point of
    compiling in the first place.
    """

    def find_package_modules(self, package, package_dir):
        modules = super().find_package_modules(package, package_dir)
        return [(pkg, mod, path) for (pkg, mod, path) in modules if mod in EXCLUDE_STEMS]


def main():
    extensions = collect_extensions("pypsx_toolkit")

    setup(
        cmdclass={"build_py": build_py},
        packages=find_packages(
            exclude=["backend*", "build*", "dist*", "tests*", "*.egg-info*"]
        ),
        ext_modules=cythonize(
            extensions,
            compiler_directives={
                "language_level": "3",
                # binding=True: wraps compiled functions so inspect.signature() works.
                # Required if FastAPI or any DI framework introspects function args.
                "binding": True,
                # embedsignature=True: embeds the Python call signature in the docstring
                # so IDEs can show it even when the .pyi stub is absent.
                "embedsignature": True,
                # annotation_typing defaults to True, which makes Cython treat a
                # PEP 484 parameter annotation like
                # `def correlation_matrix(df_dict: Dict[str, pd.DataFrame])`
                # as a `cdef dict` declaration and enforce it at the C level.
                #
                # Two problems, both COMPILED-ONLY -- they cannot reproduce from
                # source, which is the worst possible failure mode here:
                #
                #  1. Cython's builtin-container coercion is exact-type-only, so
                #     passing an OrderedDict/defaultdict/Counter to a
                #     Dict[...]-annotated parameter raises TypeError even though
                #     it is a perfectly good Mapping.
                #  2. It pre-empts the library's own validation. The argument
                #     checks in analysis/stats.py exist to say "correlation_matrix()
                #     expects {symbol: DataFrame}, got a single DataFrame" -- but
                #     with annotation_typing on, Cython rejects the call first with
                #     a terse message naming neither the function nor the fix.
                #
                # pypsx set this to False for the same reason; the toolkit had
                # been left on the default.
                "annotation_typing": False,
            },
            build_dir="build",
            annotate=False,
            nthreads=4,
        ),
        package_data={"": ["*.pyi", "py.typed"]},
        zip_safe=False,
    )


if __name__ == "__main__":
    # cythonize(nthreads=4) spawns a multiprocessing pool. On Windows
    # (spawn start method) child processes reimport this file as __main__;
    # without this guard, each child re-enters main() and re-spawns its own
    # pool, crashing the whole build with BrokenProcessPool.
    main()
