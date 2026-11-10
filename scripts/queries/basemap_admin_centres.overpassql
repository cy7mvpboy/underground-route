[out:json][timeout:300];
// 시·도 relation의 admin_centre 노드와 대표 도시(place=city) 노드
(rel[boundary=administrative][admin_level=4]["ISO3166-2"~"^KR-"];
 rel[boundary=administrative][admin_level=4][name~"전남광주"];)->.r;
node(r.r:"admin_centre");
out tags;
