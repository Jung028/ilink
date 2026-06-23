const HOME = process.env.HOME!;

export interface InfraGroup {
  name: string;
  composePath: string;
  healthPorts: number[];
  displayPorts: string;
}

export interface JavaService {
  name: string;
  dir: string;
  port: number;
}

export interface FrontendService {
  name: string;
  dir: string;
  port: number;
  startCmd: string[];
}

export const infraGroups: InfraGroup[] = [
  {
    name: "postgres-redis",
    composePath: `${HOME}/IdeaProjects/startup/docker-compose.yml`,
    healthPorts: [5432, 6379],
    displayPorts: "5432, 6379",
  },
  {
    name: "kafka-nacos",
    composePath: `${HOME}/IdeaProjects/iwallet/kafka-docker/docker-compose.yml`,
    healthPorts: [9092, 8848],
    displayPorts: "9092, 8848",
  },
];

export const frontendServices: FrontendService[] = [
  { name: "ipay",         dir: `${HOME}/IdeaProjects/ipay`,         port: 8089, startCmd: ["bun", "run", "dev"] },
  { name: "imerchantmng", dir: `${HOME}/IdeaProjects/imerchantmng`, port: 5173, startCmd: ["bun", "run", "dev"] },
];

export const services: JavaService[] = [
  { name: "iaccount",  dir: `${HOME}/IdeaProjects/iaccount`,  port: 8887 },
  { name: "iuser",     dir: `${HOME}/IdeaProjects/iuser`,     port: 8085 },
  { name: "iwallet",   dir: `${HOME}/IdeaProjects/iwallet`,   port: 8180 },
  { name: "imerchant", dir: `${HOME}/IdeaProjects/imerchant`, port: 8188 },
  { name: "iriskops",  dir: `${HOME}/IdeaProjects/iriskops`,  port: 8181 },
];
