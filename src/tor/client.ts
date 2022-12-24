import {Tor} from "tor-control-ts"
import { createLogger } from '../factories/logger-factory'
import {readFile,writeFile} from 'fs/promises';
import { homedir } from "os";
import { join } from "path";


interface torParams{
    host:string;
    port:number;
    password:string;
}

const debug = createLogger('tor-client')

const getPrivKeyFile = ()=>{
    return join(process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'),"v3_onion_private_key");
}

const createTorConfig = ():torParams => {
    return {
        host:process.env.TOR_HOST,
        port:Number(process.env.TOR_CONTROL_PORT),
        password:process.env.TOR_PASSWORD
    };
}

let client:any = null;

export const getTorClient = async () => {
    if (!client) {
        const config = createTorConfig();
        debug('config: %o', config);
        //client = knex(config)
        if(config.port){
            debug('connecting');
            client = new Tor(config);
            await client.connect();
            debug('connected to tor');
        }
        
    }

    return client
}
export const addOnion = async (port:number,host?:string):Promise<string>=>{
    let privateKey = null;

    try {
        
        let data = await readFile(getPrivKeyFile(),{
            encoding:"utf-8"
        });
        if(data && data.length){
            privateKey = data;
        }
        debug('privateKey: %o', privateKey);
    } catch (error) {
        debug('addOnion catch: %o', error);
    }

    try {
        await getTorClient();
        if(client){
            let hs = await client.addOnion(port,host,privateKey);
            if(hs && hs.PrivateKey){
                await writeFile(getPrivKeyFile(),hs.PrivateKey,{
                    encoding:"utf-8"
                });
            }

            debug('hs: %o', hs);
            debug('hidden service: ', hs.ServiceID+":"+port);
            return hs.ServiceID;
        }else{
            return null;
        }
    } catch (error) {
        debug('addOnion catch: %o', error);
        return null;
    }

}