import { addOnion, closeTorClient, createTorConfig, getTorClient } from '../../../src/tor/client'
import { hiddenService, Tor } from 'tor-control-ts'

import { expect } from 'chai'
import fs from 'fs/promises'
import { hostname } from 'os'
import Sinon from 'sinon'

export function mockModule<T extends { [K: string]: any }>
        (
            moduleToMock: T,
            defaultMockValuesForMock: Partial<{ [K in keyof T]: T[K] }>
        ) {
    return (sandbox: Sinon.SinonSandbox, returnOverrides?: Partial<{ [K in keyof T]: T[K] }>): void => {
        console.log('mockModule func')
        const functions = Object.keys(moduleToMock)
        const returns = returnOverrides || {}
        console.log('mockModule func',functions)
        functions.forEach((f) => {
            console.log('f: '+f)
            sandbox.stub(moduleToMock, f).callsFake(returns[f] || defaultMockValuesForMock[f])
        })
    }
}

describe('onion',()=>{
    Tor.prototype.connect = async function(){
        if(this ===undefined){
            throw new Error()
        }
        const opts = (this as Tor)['opts'] as {
            host:string;
            port:number;
            password:string;
        }
        if(opts.host == hostname() && opts.port == 9051 && opts.password === 'nostr_ts_relay'){
            return
        }else{
            throw new Error()
        }
    }
    Tor.prototype.quit = async function () {
        return
    }
    Tor.prototype.addOnion = async function (port, host, privateKey) {
        privateKey
        if(host){
            const validHost = /[a-zA-Z]+(:[0-9]+)?/.test(host)
            if(validHost){
                return {host,port,ServiceID:'pubKey',PrivateKey:'privKey'} as hiddenService
            }else{
                return {host,port,ServiceID:undefined,PrivateKey:undefined} as hiddenService
            }
        }else{
            return {host,port,ServiceID:'pubKey',PrivateKey:'privKey'} as hiddenService
        }
    }
    let sandbox: Sinon.SinonSandbox
    const mock = function(sandbox:Sinon.SinonSandbox,readFail?:boolean,writeFail?:boolean){
        sandbox.stub(fs,'readFile').callsFake(async (path,options) => {
            path
            options
            if(readFail){
                throw new Error()
            }
            return 'privKey'
        })
        sandbox.stub(fs,'writeFile').callsFake(async (path,options) =>{
            path
            options
            if(writeFail){
                throw new Error()
            }
            return
        })
    }

    beforeEach(() => {
        sandbox = Sinon.createSandbox()
    })
    afterEach(()=>{
        sandbox.restore()
    })

    it('config empty',()=>{
        const config = createTorConfig()
        expect(config).to.include({ port: 9051 })
    })
    it('config set',()=>{
        process.env.TOR_HOST = 'localhost'
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'test'
        const config = createTorConfig()
        // deepcode ignore NoHardcodedPasswords/test: password is part of the test
        expect(config).to.include({host: 'localhost', port: 9051,password: 'test' })
    })
    it('tor connect fail',async ()=>{
        //mockTor(sandbox)
        process.env.TOR_HOST = 'localhost'
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'

        let client:Tor = undefined
        try{
            client = await getTorClient()
            closeTorClient()
        }catch(error){
            error
        }
        expect(client).be.undefined
    })
    it('tor connect success',async ()=>{
        //mockTor(sandbox)
        process.env.TOR_HOST = hostname()
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'
        let client:Tor = undefined
        try{
            client = await getTorClient()
            closeTorClient()
        }catch(error){
            error
        }
        expect(client).be.not.undefined
    })
    it('add onion connect fail',async ()=>{
        //mockTor(sandbox)
        mock(sandbox)
        process.env.TOR_HOST = 'localhost'
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'

        let domain = undefined
        try {
            domain = await addOnion(80)
            closeTorClient()
            //domain = undefined
        } catch (error) {
            domain
        }
        expect(domain).be.undefined
    })
    it('add onion fail',async ()=>{
        //mockTor(sandbox)
        mock(sandbox)
        process.env.TOR_HOST = hostname()
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'
        process.env.NOSTR_CONFIG_DIR = '/home/node'

        let domain = undefined
        try {
            domain = await addOnion(80,'}')
            closeTorClient()
        } catch (error) {
            domain
        }
        expect(domain).be.undefined
    })
    it('add onion write fail',async ()=>{
        //mockTor(sandbox)
        mock(sandbox,false,true)
        process.env.TOR_HOST = hostname()
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'

        let domain = undefined
        try {
            domain = await addOnion(80)
            closeTorClient()
            //domain = undefined
        } catch (error) {
            domain
        }
        console.log('domain: '+domain)
        expect(domain).be.undefined
    })
    it('add onion success read fail',async ()=>{
        mock(sandbox,true)
        process.env.TOR_HOST = hostname()
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'

        let domain = undefined
        try {
            domain = await addOnion(80)
            closeTorClient()
        } catch (error) {
            domain
        }
        console.log('domain: '+domain)
        expect(domain).be.not.undefined
    })
    it('add onion success',async ()=>{
        mock(sandbox)
        process.env.TOR_HOST = hostname()
        process.env.TOR_CONTROL_PORT = '9051'
        process.env.TOR_PASSWORD = 'nostr_ts_relay'

        let domain = undefined
        try {
            domain = await addOnion(80)
            closeTorClient()
        } catch (error) {
            domain
        }
        console.log('domain: '+domain)
        expect(domain).be.not.undefined
    })
})
