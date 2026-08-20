import json
from pathlib import Path

path = Path("target/idl/rodeo_core.json")
data = json.loads(path.read_text())
print("\n".join(ix["name"] for ix in data["instructions"]))
