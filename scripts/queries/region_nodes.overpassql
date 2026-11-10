[out:json][timeout:600];
// 시·도(admin_level=4)마다: 그 안에 있는 철도 선로 노드 ID 목록. way의 가운데 노드로 시·도를 정한다.
area["ISO3166-1"="KR"][admin_level=2]->.kr;
rel(area.kr)[boundary=administrative][admin_level=4]["ISO3166-2"~"^KR-"]->.regions;
foreach.regions->.r(
  .r out tags;
  .r map_to_area->.a;
  way(area.a)[railway~"^(rail|subway|light_rail|monorail|narrow_gauge)$"]->.w;
  node(w.w)(area.a);
  out ids;
);
