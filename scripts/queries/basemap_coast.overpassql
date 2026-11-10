[out:json][timeout:600];
// 한국 영역(ISO3166-1=KR) 안의 해안선(natural=coastline). 북한·일본 해안은 영역 필터로 빠진다.
area["ISO3166-1"="KR"][admin_level=2]->.kr;
way(area.kr)[natural=coastline];
out geom;
