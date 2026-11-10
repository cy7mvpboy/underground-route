[out:json][timeout:300];
// 한국 영역의 place=city 노드
area["ISO3166-1"="KR"][admin_level=2]->.kr;
node(area.kr)[place=city];
out body;
