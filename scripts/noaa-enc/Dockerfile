# Build with --pull=false after prepare-image.py verifies the exact local base.
# No package manager, host installation, npm, or runtime internet is needed.
FROM thalassa-relief:1 AS node_extract
COPY node-v24.20.0-linux-x64.tar.xz /tmp/node.tar.xz
RUN python3 -c "import hashlib,pathlib,tarfile; p=pathlib.Path('/tmp/node.tar.xz'); assert hashlib.sha256(p.read_bytes()).hexdigest()=='2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2'; t=tarfile.open(p,'r:xz'); n=t.getmember('node-v24.20.0-linux-x64/bin/node'); assert n.isfile() and n.size<160*1024*1024; pathlib.Path('/node').mkdir(); pathlib.Path('/node/node').write_bytes(t.extractfile(n).read()); pathlib.Path('/node/node').chmod(0o755); pathlib.Path('/node/LICENSE').write_bytes(t.extractfile('node-v24.20.0-linux-x64/LICENSE').read())"

FROM thalassa-relief:1
LABEL org.thalassa.gdal-base-id="sha256:57b20fcd82df868582b1a024f7b00f181e0614950b7a7046b02a5d5cd3c2bb2e" \
      org.thalassa.node-version="24.20.0" \
      org.thalassa.node-source="https://nodejs.org/dist/v24.20.0/"
COPY --from=node_extract /node/node /usr/local/bin/node
COPY --from=node_extract /node/LICENSE /usr/share/licenses/node/LICENSE
COPY convert-cli.mjs /opt/noaa/convert-cli.mjs
RUN node --version && ogr2ogr --version
USER 65534:65534
ENTRYPOINT ["node", "/opt/noaa/convert-cli.mjs"]
