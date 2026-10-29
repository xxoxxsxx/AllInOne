export type SearchPlace = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

export type SearchResponse = {
  places: SearchPlace[];
  attribution: string;
};
