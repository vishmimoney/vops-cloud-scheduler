module.exports = function () {

    var db = require('../db');
    var Hosts = require('../db/schemas/dbHost');
    var VMAllocations = require('../db/schemas/dbAllocation');
    var unitConverter = require('../util/unitConverter')();
    var _ = require('underscore');
    var bunyan = require('bunyan');
    var logger = bunyan.createLogger({name: APP_NAME});
    var cloudstack = new (require('csclient'))({
        serverURL: CLOUDSTACK.API,
        apiKey: CLOUDSTACK.API_KEY,
        secretKey: CLOUDSTACK.SECRET_KEY
    });

    var response = require('../../config/responseMessages');

    var getValueByZabbixKey = function (host, key) {
        for (var i = 0; i < host.itemInfo.length; i++) {
            if (host.itemInfo[i].itemKey == key) {
                return host.itemInfo[i].value;
            }
        }
        return false;
    };

    var findMaxMemHost = function (hostsInfo, authorizedRequest) {

        var askingMemory = unitConverter.convertMemoryAndStorage(authorizedRequest.requestContent.group[0].min_memory[0].size[0],authorizedRequest.requestContent.group[0].min_memory[0].unit[0], 'b');

        var maxMemHostIndex;
        var maxMemHost;
        var maxMemory;

        for (var i = 0; i < hostsInfo.length-1; i++) {
            var currentMemory = getValueByZabbixKey(hostsInfo[i], 'vm.memory.size[available]');
            var nextHostMemory = getValueByZabbixKey(hostsInfo[i+1], 'vm.memory.size[available]');
            var currentTotalMemory= getValueByZabbixKey(hostsInfo[i], 'vm.memory.size[total]');
            var nextHostTotalMemory = getValueByZabbixKey(hostsInfo[i+1], 'vm.memory.size[total]');

            if ((nextHostMemory > currentMemory)&& askingMemory<= nextHostTotalMemory) {
                maxMemory = nextHostMemory;
                maxMemHostIndex = i+1;
                maxMemHost = _.clone(hostsInfo[i+1]);
            }
            else if(askingMemory <= currentTotalMemory){
                maxMemory = currentMemory;
                maxMemHostIndex = i;
                maxMemHost = _.clone(hostsInfo[i]);
            }
            else
                return null;
        }

        return hostsInfo.splice(maxMemHostIndex,1)[0];

    };

    var findHostByMigration = function (authorizedRequest, allPossibleHosts, callback) {

        var hostsInfo = _.clone(allPossibleHosts);

        findHost(hostsInfo, allPossibleHosts, authorizedRequest, function(err, candidateHost){
            if(!err){
                callback(null, candidateHost);
            }
            else{
                callback(err);
            }
        });
    };

    var findHost = function(hostsInfo, allPossibleHosts, authorizedRequest, callback){
        if(hostsInfo.length > 0){
        var candidate = findMaxMemHost(hostsInfo, authorizedRequest);
        var askingMemory = unitConverter.convertMemoryAndStorage(authorizedRequest.requestContent.group[0].min_memory[0].size[0],authorizedRequest.requestContent.group[0].min_memory[0].unit[0], 'b');

        var migrationHosts =[];

        //todo:needs testing
        for(var i=0; i< allPossibleHosts.length; i++){
            if(allPossibleHosts[i]!=candidate){
                migrationHosts.push(allPossibleHosts[i]);
            }
        }


        Hosts.findOne({ zabbixID: candidate.hostId }).exec(function (err, hostIds) {
            if(err){
                logger.error(ERROR.DB_CONNECTION_ERROR+". Error: "+JSON.stringify(err));
                callback(response.error(500, ERROR.DB_CONNECTION_ERROR, err));
            }
            else{

                var vmList = [];

                cloudstack.execute('listVirtualMachines', { hostid: hostIds.cloudstackID }, function(err, result){

                    if(err){
                        logger.error(ERROR.CLOUDSTACK_ERROR);
                        callback(response.error(500, ERROR.CLOUDSTACK_ERROR, err));
                    }
                    else{

                        var vmListResponse = result.listvirtualmachinesresponse.virtualmachine;

                        //if there are virtual machines in that host
                        if(vmListResponse) {
                            getVMSpecs(0, vmListResponse, vmList, function (err, vmList) {
                                Hosts.find({}).exec(function (err, hostArray) {
                                    if (err) {
                                        logger.error(ERROR.DB_CONNECTION_ERROR);
                                        callback(response.error(500, ERROR.DB_CONNECTION_ERROR, err));
                                    }
                                    else {
                                        //migration allocation array is created from the candidate that has chosen(migrating that VMs)

                                        var migrations = [];
                                        //if migrationHosts is null, that means no other host to migrate
                                        if (migrationHosts) {
                                            if (checkVMMigratability(vmList, hostArray, migrationHosts, _.clone(candidate), askingMemory, migrations)) {
                                                //perform migration
                                                performMigration(migrations, 0, function(err, migrationPerformed, migrationAllocation){
                                                    //candidate migrated vms and suitable for allocation
                                                    if(migrationPerformed) {
                                                        Hosts.findOne({ zabbixID: candidate.hostId }).exec(function (err, host){
                                                            if(!err){
                                                                callback(null, host);
                                                                //todo: database update for each VM(needs testing)
                                                                updateDBItem(0, migrationAllocation, function(err){
                                                                    if(err){
                                                                        callback(err);
                                                                    }
                                                                });
                                                            }
                                                            else{
                                                                callback(err);
                                                            }
                                                        });
                                                    }
                                                    else{
                                                        callback(err);
                                                    }
                                                });
                                            }
                                            else {
                                                findHost(hostsInfo, allPossibleHosts, authorizedRequest, callback);
                                            }
                                        }
                                        else {
                                            //if all hosts are checked and no suitable host found? return empty
                                            callback(null, null);
                                        }
                                    }
                                });
                            });
                        }
                        //if there are no virtual machines check whether the memory is sufficient
                        else if(askingMemory <= getValueByZabbixKey(candidate, 'vm.memory.size[available]')){
                            Hosts.findOne({ zabbixID: candidate.hostId }).exec(function (err, host){
                                if(!err){
                                    callback(null, host);
                                }
                                else{
                                    callback(err);
                                }
                            });
                        }
                        //if both doesn't work call for next hosts
                        //can't length be 0, to find max host have to have at least one host
                        else if(hostsInfo.length> 0){
                            findHost(hostsInfo, allPossibleHosts, authorizedRequest, callback);
                        }
                        //if nothing works no candidate host is there
                        else{
                            callback(null, null);
                         }

                        }
                    });
                }
            });
        }
        else{
            callback(null, null);
        }
    };


    var getVMSpecs = function (vmIndex, vmListResponse, vmList, callback) {
        if(vmIndex == vmListResponse.length){
            callback(null, vmList);
        }
        else{
            var vmID = vmListResponse[vmIndex].id;
            var vmHostID = vmListResponse[vmIndex].hostid;
            var serviceOfferingId= vmListResponse[vmIndex].serviceofferingid;

            cloudstack.execute('listServiceOfferings', {id: serviceOfferingId}, function (err, result) {
                if (err) {
                    logger.error(ERROR.CLOUDSTACK_ERROR);
                    callback(response.error(500, ERROR.CLOUDSTACK_ERROR, err));
                }
                else {
                    var serviceOffering = result.listserviceofferingsresponse.serviceoffering[0];

                    vmList[vmIndex] = {
                        vmID: vmID,
                        hostID: vmHostID,
                        detailedInfo: vmListResponse[vmIndex],
                        numOfCores: serviceOffering.cpunumber,
                        cpuFreq: serviceOffering.cpuspeed,
                        memory: serviceOffering.memory,
                        storageType: serviceOffering.storagetype,
                        offerHA: serviceOffering.offerha
                    };
                    vmIndex++;
                    getVMSpecs(vmIndex, vmListResponse, vmList, callback);
                }
            });
        }
    };


    //TODO: Needs testing
    var checkVMMigratability = function (vmList, hosts, migrationHosts, candidate, askingMemory, migrations) {

       //Setting up vmList array in to decreasing order of memory
       vmList.sort(function(a,b){return b.memory - a.memory});

        var hostMemInfo = [];
        for(var i=0; i< migrationHosts.length; i++){
            var hostMemory = getValueByZabbixKey(migrationHosts[i], 'vm.memory.size[available]');
            hostMemInfo.push({hostId: migrationHosts[i].hostId,
                                memory: hostMemory});
        }

        var candidateMem = getValueByZabbixKey(candidate, 'vm.memory.size[available]');

        hostMemInfo.sort(function(a,b){return b.memory - a.memory});

                for (var i = 0; i < vmList.length; i++) {
                    for (var j=0; j< hostMemInfo.length; j++) {
                    var vmMemory = unitConverter.convertMemoryAndStorage(vmList[i].memory, 'mb', 'b');

                    if (vmMemory <= hostMemInfo[j].memory) {

                        migrations.push({
                            vmId : vmList[i].vmID,
                            instanceName: vmList[i].detailedInfo.instancename,
                            migrationHostId: hostMemInfo[j].hostId
                        });
                        //tempUsedMemory = tempUsedMemory + vmMemory;
                        hostMemInfo[j].memory = hostMemInfo[j].memory- vmMemory;
                        candidateMem = candidateMem + vmMemory;
                        if(candidateMem >=askingMemory){
                          return true;
                        }
                        //break the loop and consider putting next vm to the host list
                        break;

                    }
                }

            }
        return false;
    };


    var performMigration = function(migrationAllocation, vmIndex,callback){

        if(vmIndex >= migrationAllocation.length){
            callback(null, true, migrationAllocation);
        }
        else{
            Hosts.findOne({ zabbixID: migrationAllocation[vmIndex].migrationHostId }).exec(function (err, hostIds) {
                cloudstack.execute('migrateVirtualMachine', {virtualmachineid:migrationAllocation[vmIndex].vmId, hostid:hostIds.cloudstackID}, function(err, res){
                    if(!err){
                        vmIndex++;
                        performMigration(migrationAllocation, vmIndex, callback);
                    }
                    else{
                        callback(err);
                    }
                });
                logger.info("Migrating Virtual machine "+migrationAllocation[vmIndex].instanceName+" to host "+hostIds.ipAddress+" ...");
            });

        }

    };

    var updateDBItem = function(vmIndex, migrationAllocation, callback){
        if(vmIndex<migrationAllocation.length){
        Hosts.findOne({ zabbixID: migrationAllocation[vmIndex].hostId }).exec(function (err, vmhost){
            var conditions = {'VM.VMID' : migrationAllocation[vmIndex].vmId};
            var update = {$set:{'VM.HostInfo': vmhost}};
            var options = {upsert: true};

            VMAllocations.update(conditions,update,options,function(err){
                if(!err){
                    vmIndex++;
                    updateDBItem(vmIndex, migrationAllocation, callback);
                }
                else{
                    callback(err);
                    }
                });
             });
        }
        else{
            callback(null);
        }
    };



    return {
        findHostByMigration: findHostByMigration
    }
};
