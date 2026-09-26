#!/usr/bin/env bash
# Synthetische PT-Demodaten für den Landing-Screenshot (#33) über die REST-API.
# Keine echten Personen. Aufruf: BASE=http://localhost:3300 TOKEN=... bash scripts/landing-demo-data.sh
set -euo pipefail
BASE="${BASE:?BASE fehlt}"; TOKEN="${TOKEN:?TOKEN fehlt}"
post() { # post <path> <json> → id
  local r; r=$(curl -fsS -X POST "$BASE$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2")
  echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id") or d.get("data",{}).get("id") or "")'
}
need() { [ -n "$1" ] || { echo "Anlegen fehlgeschlagen: $2" >&2; exit 1; }; }

# Arrendamento
P1=$(post /api/v1/records/property '{"name":"Edifício Estrela","street":"Rua da Estrela 12","zip":"1200-669","city":"Lisboa","type":"WOHNEN","management":"MIET","feeType":"PAUSCHAL","areaModel":"false"}'); need "$P1" property1
B1=$(post /api/v1/records/building "{\"propertyId\":\"$P1\",\"name\":\"Bloco A\"}"); need "$B1" building1
U11=$(post /api/v1/records/unit "{\"buildingId\":\"$B1\",\"label\":\"1.º Esq.\",\"type\":\"WOHNUNG\",\"area\":78,\"rooms\":\"3\"}"); need "$U11" unit11
U12=$(post /api/v1/records/unit "{\"buildingId\":\"$B1\",\"label\":\"1.º Dto.\",\"type\":\"WOHNUNG\",\"area\":82,\"rooms\":\"3\"}"); need "$U12" unit12
U13=$(post /api/v1/records/unit "{\"buildingId\":\"$B1\",\"label\":\"2.º Esq.\",\"type\":\"WOHNUNG\",\"area\":65,\"rooms\":\"2\"}"); need "$U13" unit13
M1=$(post /api/v1/records/person '{"firstName":"Ana","lastName":"Ferreira","email":"ana.ferreira@exemplo.pt","type":"MIETER"}'); need "$M1" person1
M2=$(post /api/v1/records/person '{"firstName":"Rui","lastName":"Costa","email":"rui.costa@exemplo.pt","type":"MIETER"}'); need "$M2" person2
L1=$(post /api/v1/records/lease "{\"unitId\":\"$U11\",\"personId\":\"$M1\",\"startDate\":\"2025-03-01\",\"rentCold\":1150,\"personCount\":2}"); need "$L1" lease1
L2=$(post /api/v1/records/lease "{\"unitId\":\"$U12\",\"personId\":\"$M2\",\"startDate\":\"2024-09-01\",\"rentCold\":1200,\"personCount\":1}"); need "$L2" lease2

# Condomínio
P2=$(post /api/v1/records/property '{"name":"Condomínio Jardim do Rato","street":"Largo do Rato 5","zip":"1250-186","city":"Lisboa","type":"WOHNEN","management":"WEG","meaTotal":"1000","feeType":"PRO_EINHEIT","feeValue":"12","areaModel":"false"}'); need "$P2" property2
B2=$(post /api/v1/records/building "{\"propertyId\":\"$P2\",\"name\":\"Edifício principal\"}"); need "$B2" building2
U21=$(post /api/v1/records/unit "{\"buildingId\":\"$B2\",\"label\":\"Fração A\",\"type\":\"WOHNUNG\",\"area\":95,\"mea\":\"350\"}"); need "$U21" unit21
U22=$(post /api/v1/records/unit "{\"buildingId\":\"$B2\",\"label\":\"Fração B\",\"type\":\"WOHNUNG\",\"area\":88,\"mea\":\"330\"}"); need "$U22" unit22
U23=$(post /api/v1/records/unit "{\"buildingId\":\"$B2\",\"label\":\"Fração C\",\"type\":\"WOHNUNG\",\"area\":84,\"mea\":\"320\"}"); need "$U23" unit23
O1=$(post /api/v1/records/person '{"firstName":"Marta","lastName":"Sousa","email":"marta.sousa@exemplo.pt","type":"EIGENTUEMER"}'); need "$O1" owner1
O2=$(post /api/v1/records/person '{"firstName":"João","lastName":"Pereira","email":"joao.pereira@exemplo.pt","type":"EIGENTUEMER"}'); need "$O2" owner2
O3=$(post /api/v1/records/person '{"firstName":"Inês","lastName":"Almeida","email":"ines.almeida@exemplo.pt","type":"EIGENTUEMER"}'); need "$O3" owner3
need "$(post /api/v1/records/owner "{\"personId\":\"$O1\",\"unitId\":\"$U21\",\"share\":1000}")" own1
need "$(post /api/v1/records/owner "{\"personId\":\"$O2\",\"unitId\":\"$U22\",\"share\":1000}")" own2
need "$(post /api/v1/records/owner "{\"personId\":\"$O3\",\"unitId\":\"$U23\",\"share\":1000}")" own3
need "$(post /api/v1/records/meeting "{\"propertyId\":\"$P2\",\"title\":\"Assembleia ordinária 2026\",\"date\":\"2026-11-12\",\"location\":\"Sala do condomínio\",\"status\":\"GEPLANT\"}")" meeting

# Operações
need "$(post /api/v1/records/ticket "{\"title\":\"Infiltração na cobertura\",\"category\":\"SCHADEN\",\"priority\":\"HOCH\",\"propertyId\":\"$P2\"}")" ticket1
need "$(post /api/v1/records/ticket "{\"title\":\"Revisão do elevador\",\"category\":\"WARTUNG\",\"priority\":\"MITTEL\",\"propertyId\":\"$P1\"}")" ticket2

# Rendas do mês (valores em aberto)
curl -fsS -X POST "$BASE/api/v1/operations/run_charge_generation" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"month\":\"$(date +%Y-%m)\"}" >/dev/null
echo "Demodaten angelegt."
