[out:json][timeout:300];
// 2026년 OSM에서 광주·전남이 '전남광주통합특별시'(ISO3166-2 태그 없음) 하나로 되어 있어 따로 받는다.
rel(21039457)->.r;
.r out tags;
.r map_to_area->.a;
way(area.a)[railway~"^(rail|subway|light_rail|monorail|narrow_gauge)$"]->.w;
node(w.w)(area.a);
out ids;
