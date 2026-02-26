import gzip, shutil, os

with gzip.open("thalassa_graph_australia_se_qld.json.gz", "rb") as f_in:
    with open("thalassa_graph_australia_se_qld.json", "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)

size = os.path.getsize("thalassa_graph_australia_se_qld.json") / 1024 / 1024
print(f"Decompressed: {size:.1f} MB")
