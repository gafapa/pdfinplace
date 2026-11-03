#!/bin/sh
set -eu

stage_root="${1:-}"
printf '%s\n' "$stage_root" | grep -Eq '^/tmp/gallegotop-content-[0-9a-f]{32}$' || exit 1
test "$(realpath -- "$stage_root")" = "$stage_root"
domain=pdfinplace.com
live_root="/opt/docker/stacks/static-sites/sites/$domain"
next_root="$stage_root/$domain"
marker="/opt/docker/backups/static-sites/$domain-current-release.sha256"
previous_files="$stage_root/previous-files.txt"
test -d "$live_root"
test -d "$next_root"

if test -f "$marker"; then
    sed -n 's/^[0-9a-f]\{64\}  //p' "$marker" > "$previous_files"
else
    # Bootstrap only the active build's chunks and fingerprinted PDF.js resources.
    find "$live_root/assets" -type f -printf 'assets/%P\n' > "$previous_files"
    for module in "$live_root"/assets/pdfjsResourceVersion-*.js; do
        test -f "$module" || continue
        versions="$(grep -Eo '[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{16}' "$module" | sort -u)"
        for version in $versions; do
            test -d "$live_root/pdfjs/$version"
            find "$live_root/pdfjs/$version" -type f -printf "pdfjs/$version/%P\n" >> "$previous_files"
        done
    done
fi

retained=0
while IFS= read -r relative_path; do
    case "$relative_path" in assets/*|pdfjs/*) ;; *) continue ;; esac
    case "$relative_path" in *..*|*[!a-zA-Z0-9_./+-]*) echo 'Unsafe retained filename.' >&2; exit 1 ;; esac
    source_path="$live_root/$relative_path"
    target_path="$next_root/$relative_path"
    test ! -L "$source_path"
    if test -f "$source_path" && ! test -e "$target_path"; then
        install -D -m 0644 "$source_path" "$target_path"
        cmp -s "$source_path" "$target_path"
        retained=$((retained + 1))
    fi
done < "$previous_files"
printf 'previous_release_files_retained=%s\n' "$retained"
