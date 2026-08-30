#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

database="$repo_root/cms/.tmp/data.db"
uploads="$repo_root/cms/public/uploads"
output=""
compare=""
root_commit=""
frontend_commit=""

usage() {
  cat <<'EOF'
Usage: scripts/audit-recovery-data.sh [options]

Create a deterministic, read-only JSON manifest for the recovered Strapi data.

Options:
  --database PATH         SQLite database (default: cms/.tmp/data.db)
  --uploads PATH          uploads directory (default: cms/public/uploads)
  --output PATH           atomically write JSON to PATH instead of stdout
  --compare PATH          fail when the generated manifest differs from PATH
  --root-commit SHA       pin the root release SHA (default: current HEAD)
  --frontend-commit SHA   pin the frontend gitlink SHA (default: HEAD:nonna.ru)
  -h, --help              show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --database|--uploads|--output|--compare|--root-commit|--frontend-commit)
      option=$1
      [ "$#" -ge 2 ] || {
        echo "Missing value for $option" >&2
        exit 2
      }
      case "$option" in
        --database) database=$2 ;;
        --uploads) uploads=$2 ;;
        --output) output=$2 ;;
        --compare) compare=$2 ;;
        --root-commit) root_commit=$2 ;;
        --frontend-commit) frontend_commit=$2 ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -f "$database" ] || {
  echo "Recovery database is missing: $database" >&2
  exit 1
}
[ -s "$database" ] || {
  echo "Recovery database is empty: $database" >&2
  exit 1
}
[ -d "$uploads" ] || {
  echo "Recovery uploads directory is missing: $uploads" >&2
  exit 1
}

for sidecar in "$database-wal" "$database-shm" "$database-journal"; do
  [ ! -e "$sidecar" ] || {
    echo "SQLite sidecar exists; stop CMS writes and checkpoint the database first: $sidecar" >&2
    exit 1
  }
done

if [ -n "$compare" ]; then
  [ -f "$compare" ] || {
    echo "Baseline manifest is missing: $compare" >&2
    exit 1
  }
fi

python_bin=${PYTHON:-}
if [ -z "$python_bin" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python_bin=python3
  elif command -v python >/dev/null 2>&1; then
    python_bin=python
  else
    echo "Python 3 is required for the recovery data audit" >&2
    exit 1
  fi
fi

if [ -z "$root_commit" ]; then
  root_commit=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null) || {
    echo "Cannot determine the root commit SHA; pass --root-commit" >&2
    exit 1
  }
fi

if [ -z "$frontend_commit" ]; then
  frontend_commit=$(git -C "$repo_root" ls-tree HEAD -- nonna.ru 2>/dev/null | awk 'NR == 1 { print $3 }')
  [ -n "$frontend_commit" ] || {
    echo "Cannot determine the nonna.ru gitlink SHA; pass --frontend-commit" >&2
    exit 1
  }
fi

temp_output=""
cleanup() {
  [ -z "$temp_output" ] || rm -f "$temp_output"
}
trap cleanup EXIT HUP INT TERM

if [ -n "$output" ]; then
  output_dir=$(dirname -- "$output")
  [ -d "$output_dir" ] || {
    echo "Output directory does not exist: $output_dir" >&2
    exit 1
  }
  temp_output=$(mktemp "$output_dir/.baseline-manifest.XXXXXX")
fi

run_audit() {
  "$python_bin" - "$database" "$uploads" "$root_commit" "$frontend_commit" "$compare" <<'PY'
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import sys
from urllib.parse import unquote, urlparse


database_path = Path(sys.argv[1]).resolve()
uploads_path = Path(sys.argv[2]).resolve()
root_commit = sys.argv[3]
frontend_commit = sys.argv[4]
compare_path = Path(sys.argv[5]).resolve() if sys.argv[5] else None

CONTENT_TABLES = (
    "coatings",
    "colors",
    "contacts",
    "countries",
    "decors",
    "parquets",
    "projects",
    "site_news_many",
    "type_of_pictures",
    "type_of_properties",
    "woods",
)

CONTENT_UIDS = {
    "api::coating.coating": "coatings",
    "api::color.color": "colors",
    "api::contact.contact": "contacts",
    "api::country.country": "countries",
    "api::decor.decor": "decors",
    "api::parquet.parquet": "parquets",
    "api::project.project": "projects",
    "api::site-news.site-news": "site_news_many",
    "api::type-of-picture.type-of-picture": "type_of_pictures",
    "api::type-of-property.type-of-property": "type_of_properties",
    "api::wood.wood": "woods",
}

BOOKKEEPING_FIELDS = {
    "id",
    "created_at",
    "updated_at",
    "published_at",
    "created_by_id",
    "updated_by_id",
    "locale",
}


class AuditError(Exception):
    pass


def terse_excepthook(error_type, error, traceback):
    if issubclass(error_type, AuditError):
        print(f"Recovery audit failed: {error}", file=sys.stderr)
    else:
        sys.__excepthook__(error_type, error, traceback)


sys.excepthook = terse_excepthook


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_bytes(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def value_sha256(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def normalize_value(value, declared_type=""):
    if isinstance(value, bytes):
        return {"hex": value.hex()}
    if isinstance(value, str) and "json" in declared_type.lower():
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def quote_identifier(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def iso_timestamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if abs(value) >= 100_000_000_000 else value
        stamp = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
        return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    text = str(value)
    if text.endswith("Z"):
        return text
    try:
        stamp = datetime.datetime.fromisoformat(text.replace(" ", "T"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=datetime.timezone.utc)
        return stamp.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return text


def upload_relative_path(url):
    if not isinstance(url, str) or not url:
        return None
    url_path = unquote(urlparse(url).path)
    prefix = "/uploads/"
    if not url_path.startswith(prefix):
        raise AuditError(f"Media URL is outside /uploads: {url}")
    relative = PurePosixPath(url_path[len(prefix) :])
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise AuditError(f"Unsafe media path in database: {url}")
    return str(relative)


def collect_format_urls(value):
    urls = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "url" and isinstance(child, str):
                urls.append(child)
            else:
                urls.extend(collect_format_urls(child))
    elif isinstance(value, list):
        for child in value:
            urls.extend(collect_format_urls(child))
    return urls


def diff_paths(expected, actual, path="$", differences=None):
    if differences is None:
        differences = []
    if len(differences) >= 50:
        return differences
    if type(expected) is not type(actual):
        differences.append(path)
    elif isinstance(expected, dict):
        for key in sorted(set(expected) | set(actual)):
            child_path = f"{path}.{key}"
            if key not in expected or key not in actual:
                differences.append(child_path)
            else:
                diff_paths(expected[key], actual[key], child_path, differences)
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            differences.append(f"{path}.length")
        for index, (expected_item, actual_item) in enumerate(zip(expected, actual)):
            diff_paths(expected_item, actual_item, f"{path}[{index}]", differences)
    elif expected != actual:
        differences.append(path)
    return differences


if not re.fullmatch(r"[0-9a-fA-F]{40,64}", root_commit):
    raise AuditError("Root commit SHA must be a 40-64 character hexadecimal value")
if not re.fullmatch(r"[0-9a-fA-F]{40,64}", frontend_commit):
    raise AuditError("Frontend commit SHA must be a 40-64 character hexadecimal value")

database_before = {
    "sha256": sha256_file(database_path),
    "size": database_path.stat().st_size,
    "mtime_ns": database_path.stat().st_mtime_ns,
}
with database_path.open("rb") as source:
    if source.read(16) != b"SQLite format 3\x00":
        raise AuditError(f"Not a SQLite 3 database: {database_path}")

database_uri = database_path.as_uri() + "?mode=ro&immutable=1"
connection = sqlite3.connect(database_uri, uri=True)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only = ON")
connection.execute("BEGIN")

integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
if integrity_rows != ["ok"]:
    raise AuditError("SQLite integrity_check failed: " + "; ".join(map(str, integrity_rows)))

foreign_key_rows = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
if foreign_key_rows:
    raise AuditError(
        "SQLite foreign_key_check failed: "
        + json.dumps(foreign_key_rows, ensure_ascii=False, separators=(",", ":"))
    )

table_names = {
    row[0]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
}
missing_tables = sorted(set(CONTENT_TABLES) - table_names)
if "files" not in table_names:
    missing_tables.append("files")
if missing_tables:
    raise AuditError("Required Strapi tables are missing: " + ", ".join(missing_tables))


def table_columns(table):
    rows = connection.execute(f"PRAGMA table_info({quote_identifier(table)})")
    return [(row[1], row[2] or "") for row in rows]


def table_rows(table):
    columns = table_columns(table)
    column_types = dict(columns)
    order_column = "id" if "id" in column_types else columns[0][0]
    rows = connection.execute(
        f"SELECT * FROM {quote_identifier(table)} ORDER BY {quote_identifier(order_column)}"
    )
    return [
        {
            key: normalize_value(row[key], column_types.get(key, ""))
            for key in row.keys()
        }
        for row in rows
    ]


relation_tables = []
relation_foreign_keys = {}
for table in sorted(table_names):
    if table in CONTENT_TABLES:
        continue
    foreign_keys = [
        {"target_table": row[2], "source_column": row[3], "target_column": row[4]}
        for row in connection.execute(f"PRAGMA foreign_key_list({quote_identifier(table)})")
    ]
    relation_foreign_keys[table] = foreign_keys
    if (
        table == "files_related_morphs"
        or table.endswith("_components")
        or any(key["target_table"] in CONTENT_TABLES for key in foreign_keys)
    ):
        relation_tables.append(table)

relations = []
relations_by_entry = {}
for table in relation_tables:
    for row in table_rows(table):
        values = {key: value for key, value in row.items() if key != "id"}
        relation = {"table": table, "values": values}
        relations.append(relation)

        for foreign_key in relation_foreign_keys.get(table, []):
            target_table = foreign_key["target_table"]
            source_column = foreign_key["source_column"]
            if target_table in CONTENT_TABLES and values.get(source_column) is not None:
                key = (target_table, values[source_column])
                relations_by_entry.setdefault(key, []).append(
                    {"table": table, "via": source_column, "values": values}
                )

        if table == "files_related_morphs":
            target_table = CONTENT_UIDS.get(values.get("related_type"))
            related_id = values.get("related_id")
            if target_table and related_id is not None:
                key = (target_table, related_id)
                relations_by_entry.setdefault(key, []).append(
                    {"table": table, "via": "related_id", "values": values}
                )

relations.sort(key=canonical_bytes)
for entry_relations in relations_by_entry.values():
    entry_relations.sort(key=canonical_bytes)

collection_summaries = []
entries = []
logical_timestamps = []
for table in CONTENT_TABLES:
    rows = table_rows(table)
    locale_counts = {}
    published_count = 0
    for row in rows:
        locale = row.get("locale") or "und"
        locale_counts[locale] = locale_counts.get(locale, 0) + 1
        published_at = row.get("published_at")
        if published_at is not None:
            published_count += 1
        if row.get("updated_at") is not None:
            logical_timestamps.append(row["updated_at"])

        stable_field = "id"
        stable_value = row.get("id")
        for candidate in ("slug", "name", "title", "address", "phone"):
            if row.get(candidate) not in (None, ""):
                stable_field = candidate
                stable_value = row[candidate]
                break

        significant_fields = {
            key: value for key, value in row.items() if key not in BOOKKEEPING_FIELDS
        }
        entry_relations = relations_by_entry.get((table, row["id"]), [])
        entries.append(
            {
                "collection": table,
                "id": row["id"],
                "locale": locale,
                "stable_key": {"field": stable_field, "value": stable_value},
                "publication": {
                    "state": "published" if published_at is not None else "draft",
                    "published_at": iso_timestamp(published_at),
                },
                "significant_fields_sha256": value_sha256(significant_fields),
                "relations_sha256": value_sha256(entry_relations),
                "relations": entry_relations,
            }
        )

    collection_summaries.append(
        {
            "name": table,
            "entry_count": len(rows),
            "published_count": published_count,
            "locale_counts": [
                {"locale": locale, "count": count}
                for locale, count in sorted(locale_counts.items())
            ],
        }
    )

entries.sort(key=lambda item: (item["collection"], item["id"]))

physical_uploads = []
physical_index = {}
physical_state = {}
for path in sorted(uploads_path.rglob("*"), key=lambda item: item.as_posix()):
    if path.is_symlink():
        raise AuditError(f"Symlinks are not allowed in recovery uploads: {path}")
    if not path.is_file() or path.name == ".gitkeep":
        continue
    relative = path.relative_to(uploads_path).as_posix()
    path_stat = path.stat()
    item = {
        "path": relative,
        "size_bytes": path_stat.st_size,
        "sha256": sha256_file(path),
    }
    physical_uploads.append(item)
    physical_index[relative] = item
    physical_state[relative] = (
        item["size_bytes"],
        path_stat.st_mtime_ns,
        item["sha256"],
    )

physical_paths = set(physical_state)

media_rows = table_rows("files")
media = []
referenced_paths = set()
missing_uploads = []
for row in media_rows:
    if row.get("updated_at") is not None:
        logical_timestamps.append(row["updated_at"])
    formats = row.get("formats")
    urls = [row.get("url")]
    urls.extend(collect_format_urls(formats))
    asset_paths = sorted(
        {
            upload_relative_path(url)
            for url in urls
            if isinstance(url, str) and url
        }
    )
    assets = []
    for relative in asset_paths:
        referenced_paths.add(relative)
        physical_item = physical_index.get(relative)
        if physical_item is None:
            missing_uploads.append(relative)
            continue
        assets.append(dict(physical_item))

    metadata = {
        key: value
        for key, value in row.items()
        if key not in {"id", "created_at", "updated_at", "created_by_id", "updated_by_id"}
    }
    media.append(
        {
            "id": row["id"],
            "name": row.get("name"),
            "url": row.get("url"),
            "metadata_sha256": value_sha256(metadata),
            "assets": assets,
        }
    )

media.sort(key=lambda item: item["id"])

orphan_uploads = [
    item for item in physical_uploads if item["path"] not in referenced_paths
]

if missing_uploads:
    raise AuditError(
        "Referenced uploads are missing: " + ", ".join(sorted(set(missing_uploads)))
    )

database_timestamp = max(logical_timestamps) if logical_timestamps else None
manifest = {
    "schema_version": 1,
    "release": {
        "root_commit_sha": root_commit.lower(),
        "frontend_submodule_path": "nonna.ru",
        "frontend_commit_sha": frontend_commit.lower(),
    },
    "database": {
        "sha256": database_before["sha256"],
        "size_bytes": database_before["size"],
        "logical_updated_at_utc": iso_timestamp(database_timestamp),
        "integrity_check": "ok",
        "foreign_key_violations": [],
    },
    "summary": {
        "collection_count": len(CONTENT_TABLES),
        "entry_count": len(entries),
        "published_entry_count": sum(
            item["published_count"] for item in collection_summaries
        ),
        "media_row_count": len(media),
        "referenced_upload_count": len(referenced_paths),
        "physical_upload_count": len(physical_uploads),
        "missing_referenced_upload_count": 0,
        "orphan_upload_count": len(orphan_uploads),
        "relation_count": len(relations),
    },
    "collections": collection_summaries,
    "entries": entries,
    "relations": relations,
    "media": media,
    "uploads": {
        "physical_files": physical_uploads,
        "orphan_files": orphan_uploads,
    },
}

connection.rollback()
connection.close()

database_after = {
    "sha256": sha256_file(database_path),
    "size": database_path.stat().st_size,
    "mtime_ns": database_path.stat().st_mtime_ns,
}
if database_before != database_after:
    raise AuditError("Source database changed while it was being audited")
for suffix in ("-wal", "-shm", "-journal"):
    sidecar = Path(str(database_path) + suffix)
    if sidecar.exists():
        raise AuditError(f"SQLite sidecar appeared while auditing: {sidecar}")

physical_paths_after = set()
for path in uploads_path.rglob("*"):
    if path.is_symlink():
        raise AuditError(f"Symlinks are not allowed in recovery uploads: {path}")
    if not path.is_file() or path.name == ".gitkeep":
        continue
    relative = path.relative_to(uploads_path).as_posix()
    physical_paths_after.add(relative)
    path_stat = path.stat()
    state = (path_stat.st_size, path_stat.st_mtime_ns, sha256_file(path))
    if physical_state.get(relative) != state:
        raise AuditError(f"Source upload changed while it was being audited: {relative}")
if physical_paths_after != physical_paths:
    raise AuditError("The set of source uploads changed while it was being audited")

if compare_path:
    try:
        with compare_path.open("r", encoding="utf-8") as source:
            expected_manifest = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        raise AuditError(f"Cannot read baseline manifest {compare_path}: {error}") from error
    differences = diff_paths(expected_manifest, manifest)
    if differences:
        preview = ", ".join(differences[:20])
        if len(differences) > 20:
            preview += f", ... ({len(differences)} differences inspected)"
        raise AuditError(f"Manifest comparison failed at: {preview}")

if orphan_uploads:
    print(
        "Orphan uploads (reported, not deleted): "
        + ", ".join(item["path"] for item in orphan_uploads),
        file=sys.stderr,
    )

json.dump(manifest, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
sys.stdout.write("\n")
print(
    "Recovery audit passed: "
    f"{manifest['summary']['collection_count']} collections, "
    f"{manifest['summary']['published_entry_count']} published entries, "
    f"{manifest['summary']['media_row_count']} media rows, "
    f"{manifest['summary']['referenced_upload_count']} referenced uploads",
    file=sys.stderr,
)
PY
}

if [ -n "$temp_output" ]; then
  if ! run_audit >"$temp_output"; then
    exit 1
  fi
  chmod 0644 "$temp_output"
  mv -f "$temp_output" "$output"
  temp_output=""
else
  run_audit
fi
