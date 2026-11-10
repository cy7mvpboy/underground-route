[out:json][timeout:600];
// 시·도(admin_level=4) 경계 relation. 좌표 포함. 한국 영역(ISO3166-1=KR) 안의 것만.
rel[boundary=administrative][admin_level=4]["ISO3166-2"~"^KR-"];
out geom;
rel[boundary=administrative][admin_level=4][name~"전남광주"];
out geom;
